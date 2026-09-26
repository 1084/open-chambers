// Parsers for the official vote feeds. Pure functions, no network, so they can be
// unit-tested against saved samples.

/* ---------- tiny XML helpers (the feeds are simple, regular XML) ---------- */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1].trim()) : "";
}
function attr(xml, name) {
  const m = xml.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : "";
}
function all(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "g"))].map(m => m[0]);
}
function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function norm(v) {
  v = (v || "").trim().toLowerCase();
  if (v === "yea" || v === "aye" || v === "yes") return "Y";
  if (v === "nay" || v === "no") return "N";
  if (v === "present") return "P";
  return "-"; // not voting
}

/* ---------- House: clerk.house.gov/evs/<year>/roll<NNN>.xml ---------- */
export function parseHouseVote(xml) {
  const meta = tag(xml, "vote-metadata");
  if (!meta) return null;
  const positions = {};
  for (const rv of all(xml, "recorded-vote")) {
    const leg = rv.match(/<legislator([^>]*)>/);
    if (!leg) continue;
    const id = attr(leg[1], "name-id");
    positions[id] = norm(tag(rv, "vote"));
  }
  const totals = tag(meta, "totals-by-vote");
  const num = tag(meta, "rollcall-num");
  const congress = tag(meta, "congress");
  const session = tag(meta, "session").replace(/\D/g, "");
  return {
    id: `h-${congress}-${session}-${String(num).padStart(3, "0")}`,
    chamber: "house",
    congress: +congress,
    session: +session,
    number: +num,
    date: toISO(tag(meta, "action-date")),
    question: tag(meta, "vote-question"),
    description: tag(meta, "vote-desc"),
    bill: tag(meta, "legis-num"),
    result: tag(meta, "vote-result"),
    type: tag(meta, "vote-type"),
    tally: { yea: +tag(totals, "yea-total") || 0, nay: +tag(totals, "nay-total") || 0, present: +tag(totals, "present-total") || 0, nv: +tag(totals, "not-voting-total") || 0 },
    positions,
  };
}

/* ---------- Senate: senate.gov/legislative/LIS/roll_call_votes/vote<C><S>/vote_<C>_<S>_<NNNNN>.xml ---------- */
export function parseSenateVote(xml) {
  if (!xml.includes("<roll_call_vote")) return null;
  const positions = {};
  for (const m of all(xml, "member")) {
    positions[tag(m, "lis_member_id")] = norm(tag(m, "vote_cast"));
  }
  const congress = tag(xml, "congress"), session = tag(xml, "session"), num = tag(xml, "vote_number");
  const count = tag(xml, "count");
  const doc = tag(xml, "document");
  return {
    id: `s-${congress}-${session}-${String(+num).padStart(5, "0")}`,
    chamber: "senate",
    congress: +congress,
    session: +session,
    number: +num,
    date: toISO(tag(xml, "vote_date")),
    question: tag(xml, "vote_question_text") || tag(xml, "question"),
    description: tag(xml, "vote_title") || tag(doc, "document_title"),
    bill: tag(doc, "document_name"),
    result: tag(xml, "vote_result"),
    type: tag(xml, "majority_requirement"),
    tally: { yea: +tag(count, "yeas") || 0, nay: +tag(count, "nays") || 0, present: +tag(count, "present") || 0, nv: +tag(count, "absent") || 0 },
    positions, // keyed by LIS id; caller maps to bioguide
  };
}

/* ---------- Senate vote menu: roll_call_lists/vote_menu_<C>_<S>.xml ---------- */
export function parseSenateMenu(xml) {
  return all(xml, "vote").map(v => ({ number: +tag(v, "vote_number"), date: toISO(tag(v, "vote_date")), question: tag(v, "question"), result: tag(v, "result"), issue: tag(v, "issue"), title: tag(v, "title") }));
}

/* ---------- Voteview members CSV (HS<congress>_members.csv) ---------- */
export function parseVoteviewMembers(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const head = splitCSV(lines[0]);
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const out = {};
  for (const line of lines.slice(1)) {
    const c = splitCSV(line);
    const bio = c[idx.bioguide_id];
    const dim1 = parseFloat(c[idx.nominate_dim1]);
    if (!bio || Number.isNaN(dim1)) continue;
    out[bio] = { dim1, dim2: parseFloat(c[idx.nominate_dim2]), icpsr: c[idx.icpsr], votes: +c[idx.nominate_number_of_votes] || 0 };
  }
  return out;
}

/* ---------- ZIP → district CSV (state_fips,state_abbr,zcta,cd) ---------- */
export function parseZipDistricts(csv) {
  const out = {};
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [, st, zcta, cd] = line.split(",");
    if (!zcta) continue;
    (out[zcta] ||= []).push(`${st}-${+cd}`);
  }
  return out;
}

function splitCSV(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
}
function toISO(d) {
  // House: "3-Jan-2025"; Senate: "January 3, 2025,  12:34 PM" or "2025-01-03"
  if (!d) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const t = Date.parse(d.replace(/,\s+\d{1,2}:\d{2}\s*[AP]M$/i, ""));
  return Number.isNaN(t) ? d : new Date(t).toISOString().slice(0, 10);
}
