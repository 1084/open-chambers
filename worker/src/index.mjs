// Open Chambers — alerts API (Cloudflare Worker)
//
// Two jobs:
//   1. HTTP: phones register their push token and the members they follow.
//      POST /v1/subscribe   { token, follows: [bioguide...], mode: "passage"|"all", summary: bool, quiet: bool }
//      DELETE /v1/subscribe { token }
//      GET  /v1/health
//   2. Cron: look for roll-call votes newer than the last one seen, and push to
//      everyone following a member who voted, with the official bill summary.
//
// It stores nothing about a person except an anonymous APNs device token and the
// member ids that token follows. No names, no ZIP codes, no emails.

import { parseHouseVote, parseSenateVote, parseSenateMenu } from "./parsers.mjs";
import { sendPush } from "./apns.mjs";

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", ...extra } });
const now = () => new Date().toISOString();
const UA = { "user-agent": "openchambers-alerts (johnhubert.llc; support@johnhubert.llc)" };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-max-age": "86400" } });
    if (url.pathname === "/v1/health") {
      const s = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM subscriptions) AS subs, (SELECT COUNT(*) FROM seen_votes) AS seen").first();
      const last = await getState(env, "last_run");
      return json({ ok: true, subscriptions: s.subs, votesSeen: s.seen, lastRun: last });
    }
    if (url.pathname === "/v1/subscribe" && req.method === "POST") {
      const b = await req.json().catch(() => null);
      if (!b || !/^[0-9a-f]{64,200}$/i.test(b.token || "")) return json({ error: "token required" }, 400);
      const follows = [...new Set((b.follows || []).filter(x => /^[A-Z]\d{6}$/.test(x)))].slice(0, 20);
      const mode = b.mode === "all" ? "all" : "passage";
      await env.DB.batch([
        env.DB.prepare("INSERT INTO subscriptions (token, mode, summary, quiet, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(token) DO UPDATE SET mode=?2, summary=?3, quiet=?4, updated_at=?5").bind(b.token, mode, b.summary === false ? 0 : 1, b.quiet ? 1 : 0, now()),
        env.DB.prepare("DELETE FROM follows WHERE token = ?1").bind(b.token),
        ...follows.map(m => env.DB.prepare("INSERT OR IGNORE INTO follows (token, member_id) VALUES (?1, ?2)").bind(b.token, m)),
      ]);
      return json({ ok: true, follows: follows.length, mode });
    }
    if (url.pathname === "/v1/subscribe" && req.method === "DELETE") {
      const b = await req.json().catch(() => null);
      if (!b?.token) return json({ error: "token required" }, 400);
      await env.DB.batch([env.DB.prepare("DELETE FROM follows WHERE token = ?1").bind(b.token), env.DB.prepare("DELETE FROM subscriptions WHERE token = ?1").bind(b.token), env.DB.prepare("DELETE FROM queued WHERE token = ?1").bind(b.token)]);
      return json({ ok: true });
    }
    if (url.pathname === "/v1/summary" && req.method === "GET") {
      // Bill summary for a vote id (e.g. h-119-2-012). Reads the vote from the site's data, then Congress.gov (cached).
      const id = url.searchParams.get("vote") || "";
      if (!/^[hs]-\d{3}-[12]-\d{3,5}$/.test(id)) return json({ error: "bad vote id" }, 400);
      const r = await fetch(`${env.DATA_BASE}/votes/${id}.json`, { headers: UA });
      if (!r.ok) return json({ error: "vote not found" }, 404);
      const v = await r.json();
      const summary = await billSummary(env, v);
      return json({ vote: id, bill: v.bill || null, summary }, 200, { "cache-control": "public, max-age=3600" });
    }
    if (url.pathname === "/v1/status" && req.method === "GET") {
      // Admin view: everything needed to answer "is it working?". Protected by the Congress key.
      if (url.searchParams.get("key") !== env.CONGRESS_API_KEY) return json({ error: "no" }, 403);
      const state = Object.fromEntries((await env.DB.prepare("SELECT key, value FROM state WHERE key NOT LIKE 'summary:%' AND key NOT LIKE 'members_cache%'").all()).results.map(r => [r.key, r.value]));
      const counts = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM subscriptions) AS subs, (SELECT COUNT(*) FROM follows) AS follows, (SELECT COUNT(*) FROM seen_votes) AS seen, (SELECT COUNT(*) FROM queued) AS queued").first();
      const recent = (await env.DB.prepare("SELECT vote_id, seen_at FROM seen_votes ORDER BY seen_at DESC LIMIT 10").all()).results;
      const subs = (await env.DB.prepare("SELECT substr(token,1,8) AS token, mode, summary, quiet, updated_at, (SELECT COUNT(*) FROM follows f WHERE f.token = s.token) AS follows FROM subscriptions s").all()).results;
      const membersCacheAt = await getState(env, "members_cache_at");
      return json({ now: now(), state, counts, recentVotes: recent, subscriptions: subs, membersCacheAt: membersCacheAt ? new Date(+membersCacheAt).toISOString() : null, secrets: { APNS_KEY: !!env.APNS_KEY, APNS_KEY_ID: !!env.APNS_KEY_ID, APNS_TEAM_ID: !!env.APNS_TEAM_ID, CONGRESS_API_KEY: !!env.CONGRESS_API_KEY }, config: { DATA_BASE: env.DATA_BASE, CONGRESS: env.CONGRESS, APNS_HOST: env.APNS_HOST, APNS_TOPIC: env.APNS_TOPIC } });
    }
    if (url.pathname === "/v1/poll" && req.method === "POST") {
      // Run one poll now (same as the cron). Protected by the Congress key.
      const b = await req.json().catch(() => ({}));
      if (b.key !== env.CONGRESS_API_KEY) return json({ error: "no" }, 403);
      try { await poll(env); return json({ ok: true, lastRun: await getState(env, "last_run") }); }
      catch (e) { await setState(env, "last_error", `${now()} ${e && e.stack || e}`.slice(0, 2000)); return json({ ok: false, error: String(e && e.message || e) }, 500); }
    }
    if (url.pathname === "/v1/test-push" && req.method === "POST") {
      // Sends a test notification to one token. Protected by the Congress key so only you can call it.
      const b = await req.json().catch(() => ({}));
      if (b.key !== env.CONGRESS_API_KEY) return json({ error: "no" }, 403);
      const r = await sendPush(env, b.token, { title: "Open Chambers is connected", body: "You'll get a notification here when one of your representatives votes.", data: { test: true } });
      return json(r);
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env).catch(async e => { console.error("poll failed", e); await setState(env, "last_error", `${now()} ${e && e.stack || e}`.slice(0, 2000)).catch(() => {}); }));
  },
};

/* ---------------- polling ---------------- */
async function poll(env) {
  const started = now();
  const congress = +env.CONGRESS;
  const year = new Date().getUTCFullYear();
  const session = year - (1789 + (congress - 1) * 2) + 1; // 2025 → 1, 2026 → 2
  const members = await membersMap(env);
  const newVotes = [];

  // House: probe roll numbers after the last one we saw this session.
  const hKey = `house_last_${congress}_${session}`;
  const sKey = `senate_last_${congress}_${session}`;
  if ((await getState(env, hKey)) === null || (await getState(env, sKey)) === null) await seedHighWater(env, hKey, sKey, congress, session);
  let last = +(await getState(env, hKey) || 0);
  for (let i = 0; i < 25; i++) {
    const n = last + 1;
    const r = await fetch(`https://clerk.house.gov/evs/${year}/roll${String(n).padStart(3, "0")}.xml`, { headers: UA });
    if (r.status === 404) break;
    if (!r.ok) { console.warn("house", n, r.status); break; }
    const v = parseHouseVote(await r.text()); if (!v) break;
    v.id = `h-${congress}-${session}-${String(n).padStart(3, "0")}`; v.session = session;
    newVotes.push(v); last = n;
  }
  await setState(env, hKey, String(last));

  // Senate: the menu lists every vote of the session; take the ones past our high-water mark.
  let sLast = +(await getState(env, sKey) || 0);
  const menu = await fetch(`https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`, { headers: UA });
  if (menu.ok) {
    const list = parseSenateMenu(await menu.text()).filter(i => i.number > sLast).sort((a, b) => a.number - b.number).slice(0, 25);
    for (const item of list) {
      const r = await fetch(`https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${String(item.number).padStart(5, "0")}.xml`, { headers: UA });
      if (!r.ok) continue;
      const v = parseSenateVote(await r.text()); if (!v) continue;
      const pos = {}; for (const [lis, p] of Object.entries(v.positions)) { const b = members.lisToBio[lis]; if (b) pos[b] = p; }
      v.positions = pos; if (!v.description) v.description = item.title || item.issue;
      newVotes.push(v); sLast = item.number;
    }
    await setState(env, sKey, String(sLast));
  }

  let sent = 0;
  for (const v of newVotes) {
    const already = await env.DB.prepare("SELECT 1 FROM seen_votes WHERE vote_id = ?1").bind(v.id).first();
    if (already) continue;
    await env.DB.prepare("INSERT OR IGNORE INTO seen_votes (vote_id, seen_at) VALUES (?1, ?2)").bind(v.id, now()).run();
    sent += await notify(env, v, members);
  }
  await flushQueued(env);
  await setState(env, "last_run", `${started} house=${last} senate=${sLast} new=${newVotes.length} sent=${sent}`);
  console.log("poll", started, "new", newVotes.length, "sent", sent);
}

// On a fresh database, start from the newest vote the website already knows about instead of vote 1,
// so the first polls do not send notifications for months-old roll calls.
async function seedHighWater(env, hKey, sKey, congress, session) {
  let h = 0, s = 0;
  try {
    const idx = await fetch(`${env.DATA_BASE}/votes-index.json`, { headers: UA }).then(r => r.json());
    for (const v of idx) {
      const m = /^([hs])-(\d+)-(\d)-(\d+)$/.exec(v.id); if (!m || +m[2] !== congress || +m[3] !== session) continue;
      if (m[1] === "h") h = Math.max(h, +m[4]); else s = Math.max(s, +m[4]);
    }
  } catch (e) { console.warn("seed", e.message); }
  if ((await getState(env, hKey)) === null) await setState(env, hKey, String(h));
  if ((await getState(env, sKey)) === null) await setState(env, sKey, String(s));
  await setState(env, "seeded", `${now()} house=${h} senate=${s}`);
}

const PASSAGE = /passage|on agreeing to the resolution|on the (joint )?resolution|concur|conference report|override|on the amendment .* as amended|final/i;
const isPassage = v => PASSAGE.test(v.question || "") && !/motion to (proceed|table|recommit|reconsider)|cloture|quorum|previous question|adjourn/i.test(v.question || "");

async function notify(env, v, members) {
  const voters = Object.keys(v.positions);
  if (!voters.length) return 0;
  // Who follows anyone who voted? One query, then group by token.
  const rows = (await env.DB.prepare(`SELECT f.token, f.member_id, s.mode, s.summary, s.quiet FROM follows f JOIN subscriptions s ON s.token = f.token WHERE f.member_id IN (${voters.map(() => "?").join(",")})`).bind(...voters).all()).results;
  if (!rows.length) return 0;
  const passage = isPassage(v);
  const summary = await billSummary(env, v);
  const chamber = v.chamber === "senate" ? "Senate" : "House";
  const resultLine = `${v.result || "Vote"} ${v.tally.yea}–${v.tally.nay}`;
  const byToken = {};
  for (const r of rows) { if (r.mode === "passage" && !passage) continue; (byToken[r.token] ||= { r, ids: [] }).ids.push(r.member_id); }
  let sent = 0;
  for (const [token, { r, ids }] of Object.entries(byToken)) {
    for (const id of ids) {
      const m = members.byId[id]; if (!m) continue;
      const p = v.positions[id];
      const posWord = p === "Y" ? "voted Yea" : p === "N" ? "voted Nay" : p === "P" ? "voted Present" : "did not vote";
      const bill = v.bill ? `${v.bill} · ` : "";
      const title = `${m.name} ${posWord}`;
      const subtitle = `${v.question || chamber + " vote"}${v.bill ? " · " + v.bill : ""}`;
      const first = (r.summary && summary) ? " " + firstSentence(summary) : "";
      const body = `${v.description || bill + chamber + " roll call " + v.number} — ${resultLine}.${first}`.slice(0, 900);
      const payload = { title, subtitle, body, data: { voteId: v.id, memberId: id, url: `https://johnhubert.llc/floor/#/vote/${v.id}` } };
      if (r.quiet && isQuietHoursET()) {
        await env.DB.prepare("INSERT INTO queued (token, payload, created_at) VALUES (?1, ?2, ?3)").bind(token, JSON.stringify({ payload, collapseId: `${v.id}:${id}`, threadId: id }), now()).run();
        continue;
      }
      const res = await sendPush(env, token, payload, { collapseId: `${v.id}:${id}`, threadId: id });
      if (res.ok) sent++;
      else if (res.status === 410 || res.reason === "BadDeviceToken" || res.reason === "Unregistered") await dropToken(env, token);
      else console.warn("apns", res.status, res.reason);
    }
  }
  return sent;
}

async function flushQueued(env) {
  if (isQuietHoursET()) return;
  const rows = (await env.DB.prepare("SELECT id, token, payload FROM queued ORDER BY id LIMIT 200").all()).results;
  for (const q of rows) {
    const { payload, collapseId, threadId } = JSON.parse(q.payload);
    const res = await sendPush(env, q.token, payload, { collapseId, threadId });
    if (!res.ok && (res.status === 410 || res.reason === "BadDeviceToken")) await dropToken(env, q.token);
    await env.DB.prepare("DELETE FROM queued WHERE id = ?1").bind(q.id).run();
  }
}
function isQuietHoursET() {
  const h = +new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(new Date());
  return h >= 22 || h < 8;
}
async function dropToken(env, token) {
  await env.DB.batch([env.DB.prepare("DELETE FROM follows WHERE token = ?1").bind(token), env.DB.prepare("DELETE FROM subscriptions WHERE token = ?1").bind(token)]);
}

/* ---------------- bill summaries (Congressional Research Service, via Congress.gov API) ---------------- */
const TYPE = { "H R": "hr", "HR": "hr", "H.R.": "hr", "S": "s", "S.": "s", "H J RES": "hjres", "H.J.RES.": "hjres", "S J RES": "sjres", "S.J.RES.": "sjres", "H RES": "hres", "H.RES.": "hres", "S RES": "sres", "S.RES.": "sres", "H CON RES": "hconres", "H.CON.RES.": "hconres", "S CON RES": "sconres", "S.CON.RES.": "sconres" };
export function parseBill(s) {
  if (!s) return null;
  const m = s.trim().toUpperCase().replace(/\s+/g, " ").match(/^([A-Z][A-Z .]*?)\s*(\d+)$/);
  if (!m) return null;
  const type = TYPE[m[1].trim()] || TYPE[m[1].replace(/\./g, "").replace(/\s+/g, " ").trim()];
  return type ? { type, number: +m[2] } : null;
}
async function billSummary(env, v) {
  if (!env.CONGRESS_API_KEY) return "";
  const b = parseBill(v.bill); if (!b) return "";
  try {
    const cacheKey = `summary:${v.congress}:${b.type}:${b.number}`;
    const hit = await getState(env, cacheKey); if (hit) return hit;
    const r = await fetch(`https://api.congress.gov/v3/bill/${v.congress}/${b.type}/${b.number}/summaries?format=json&api_key=${env.CONGRESS_API_KEY}`, { headers: UA });
    if (!r.ok) return "";
    const j = await r.json();
    const list = j.summaries || []; if (!list.length) return "";
    const latest = list[list.length - 1];
    const text = stripHtml(latest.text || "");
    await setState(env, cacheKey, text.slice(0, 4000));
    return text;
  } catch (e) { console.warn("summary", e.message); return ""; }
}
const stripHtml = s => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function firstSentence(t) { const m = t.match(/^(.{40,320}?[.!?])(\s|$)/); return (m ? m[1] : t.slice(0, 240)).trim(); }

/* ---------------- members map (from the site's nightly data), cached 6h ---------------- */
async function membersMap(env) {
  const raw = await getState(env, "members_cache");
  const ts = +(await getState(env, "members_cache_at") || 0);
  let list;
  if (raw && Date.now() - ts < 6 * 3600e3) list = JSON.parse(raw);
  else {
    const r = await fetch(`${env.DATA_BASE}/members.json`, { headers: UA });
    const full = await r.json();
    list = full.map(m => ({ id: m.id, name: m.name, lis: m.ids?.lis || null, chamber: m.chamber, state: m.state, district: m.district }));
    await setState(env, "members_cache", JSON.stringify(list)); await setState(env, "members_cache_at", String(Date.now()));
  }
  const byId = Object.fromEntries(list.map(m => [m.id, m]));
  const lisToBio = Object.fromEntries(list.filter(m => m.lis).map(m => [m.lis, m.id]));
  return { byId, lisToBio };
}
async function getState(env, k) { const r = await env.DB.prepare("SELECT value FROM state WHERE key = ?1").bind(k).first(); return r ? r.value : null; }
async function setState(env, k, v) { await env.DB.prepare("INSERT INTO state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2").bind(k, v).run(); }
