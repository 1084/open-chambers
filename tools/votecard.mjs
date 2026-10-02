#!/usr/bin/env node
// Open Chambers vote card generator.
//   node votecard.mjs <vote-id> <bioguide-id>[,<bioguide-id>...] [--title "Short bill title"] [--out dir]
// Produces square (1080x1080) and story (1080x1920) PNGs from the live data on johnhubert.llc,
// in the app's brand style, with the official portraits. Needs: npm i playwright (uses the bundled Chromium).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const DATA = process.env.OC_DATA || "https://johnhubert.llc/floor/data/";
const args = process.argv.slice(2);
const voteId = args[0], ids = (args[1] || "").split(",").filter(Boolean);
const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const title = opt("--title", null), out = opt("--out", "cards");
if (!voteId || !ids.length) { console.error("usage: node votecard.mjs <vote-id> <bioguide,...> [--title ...] [--out dir]"); process.exit(1); }
const vote = await fetch(`${DATA}votes/${voteId}.json`).then(r => r.json());
const members = await fetch(`${DATA}members.json`).then(r => r.json());
const byId = Object.fromEntries(members.map(m => [m.id, m]));
const picked = ids.map(id => byId[id]).filter(Boolean);
for (const m of picked) if (m.chamber !== vote.chamber) { console.error(`${m.name} is in the ${m.chamber}; this is a ${vote.chamber} vote.`); process.exit(1); }
const MAX = { square: 3, story: 6 };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const POS = { Y: ["YEA", "#2E7D4F", "#E3F0E8"], N: ["NAY", "#B23A3A", "#F6E3E3"], P: ["PRESENT", "#7C818A", "#ECECEC"], "-": ["NO VOTE", "#7C818A", "#ECECEC"] };
const chamber = vote.chamber === "senate" ? "Senate" : "House";
const date = new Date(vote.date + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const headline = title || vote.description || vote.bill || vote.question;
const t = vote.tally, tot = t.yea + t.nay + t.present + t.nv;
const passed = /pass|agree|adopt|confirm/i.test(vote.result || "");
const seat = m => m.chamber === "senate" ? `Senator, ${m.state}` : `Representative, ${m.state}-${m.district || "AL"}`;

function html(w, h) {
  const story = h > w;
  const bp = vote.byParty || {};
  const split = [["D","Democrats"],["R","Republicans"],["I","Independents"]].filter(([k]) => bp[k] && (bp[k].Y + bp[k].N)).map(([k,l]) => `<span><i class="dot ${k}"></i>${l} ${bp[k].Y}–${bp[k].N}</span>`).join("");
  const shown = picked.slice(0, story ? MAX.story : MAX.square);
  if (shown.length < picked.length) console.warn(`${story ? "story" : "square"} card shows the first ${shown.length} of ${picked.length} members`);
  const rows = shown.map(m => { const p = vote.positions[m.id] ?? "-"; const [label, fg, bg] = POS[p]; return `
    <div class="row"><img class="pic" src="https://unitedstates.github.io/images/congress/225x275/${m.id}.jpg" onerror="this.outerHTML='<div class=&quot;pic ini&quot;>${esc((m.first||"")[0] + (m.last||"")[0])}</div>'">
      <div class="who"><div class="nm">${esc(m.name)}</div><div class="st"><i class="dot ${m.partyCode}"></i>${esc(m.party)} · ${esc(seat(m))}</div></div>
      <div class="pos" style="color:${fg};background:${bg}">${label}</div></div>`; }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @import url('https://fonts.googleapis.com/css2?family=Newsreader:wght@600;700&family=Public+Sans:wght@400;500;600&display=swap');
    body{margin:0;width:${w}px;height:${h}px;background:#F7F6F2;font-family:"Public Sans",-apple-system,Helvetica,sans-serif;color:#1A1D21;overflow:hidden}
    .card{box-sizing:border-box;width:${w}px;height:${h}px;padding:${story?110:72}px ${story?72:72}px;display:flex;flex-direction:column}
    .top{display:flex;align-items:center;gap:16px;margin-bottom:${story?56:36}px}.mark{width:56px;height:56px;border-radius:14px;background:#1F3A5F;display:grid;place-items:center}
    .brand{font-family:Newsreader,Georgia,serif;font-weight:600;font-size:34px}.kicker{font-family:"SF Mono",Menlo,monospace;font-size:${story?24:22}px;letter-spacing:.1em;text-transform:uppercase;color:#7C818A;margin-bottom:${story?22:16}px}
    h1{font-family:Newsreader,Georgia,serif;font-weight:700;font-size:${story?72:58}px;line-height:1.08;margin:0 0 ${story?26:18}px;letter-spacing:-.01em}
    .res{font-size:${story?34:28}px;font-weight:600;color:${passed?"#2E7D4F":"#B23A3A"};margin-bottom:${story?44:30}px}
    .split{display:flex;gap:28px;font-size:${story?24:21}px;color:#4A4F57;margin:-${story?34:22}px 0 ${story?44:30}px}
    .bar{height:${story?22:18}px;border-radius:11px;overflow:hidden;display:flex;background:#E4E2DB;margin-bottom:${story?56:40}px}.bar i{display:block;height:100%}
    .row{display:flex;align-items:center;gap:22px;background:#fff;border:2px solid #E4E2DB;border-radius:24px;padding:${story?18:16}px ${story?26:22}px;margin-bottom:${story?18:16}px}
    .pic{width:${story?96:92}px;height:${story?116:112}px;border-radius:16px;object-fit:cover;background:#EFEDE7;flex:0 0 auto}.ini{display:grid;place-items:center;font-family:Newsreader,serif;font-size:36px;color:#7C818A}
    .who{flex:1;min-width:0}.nm{font-family:Newsreader,Georgia,serif;font-weight:600;font-size:${story?38:34}px;line-height:1.1}.st{font-size:${story?26:22}px;color:#4A4F57;margin-top:6px}
    .dot{display:inline-block;width:14px;height:14px;border-radius:50%;margin-right:8px;vertical-align:middle}.D{background:#3B6FB6}.R{background:#C4423A}.I{background:#6B8E23}
    .pos{font-family:"SF Mono",Menlo,monospace;font-size:${story?28:24}px;letter-spacing:.08em;font-weight:600;padding:12px 20px;border-radius:12px}
    .foot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;font-size:${story?26:22}px;color:#4A4F57}.foot b{color:#1F3A5F;font-weight:600}
    .src{font-family:"SF Mono",Menlo,monospace;font-size:${story?20:18}px;color:#7C818A;letter-spacing:.04em}
  </style></head><body><div class="card">
    <div class="top"><div class="mark"><svg viewBox="0 0 1024 1024" width="40" height="40">${MARK}</svg></div><div class="brand">Open Chambers</div></div>
    <div class="kicker">${chamber} · Roll call ${vote.number} · ${date}</div>
    <h1>${esc(headline)}</h1>
    <div class="res">${esc(vote.result || "Vote")} ${t.yea}–${t.nay}</div>
    <div class="bar"><i style="width:${t.yea/tot*100}%;background:#2E7D4F"></i><i style="width:${t.nay/tot*100}%;background:#B23A3A"></i><i style="width:${(t.present+t.nv)/tot*100}%;background:#A5A9B0"></i></div>
    <div class="split">${split}</div>
    ${rows}
    <div class="foot"><div><b>See how yours voted.</b><br>Free iPhone app · johnhubert.llc/floor</div><div class="src">Source: ${vote.chamber === "senate" ? "senate.gov" : "clerk.house.gov"}</div></div>
  </div></body></html>`;
}
const MARK = (() => { let s = ""; const rows = [[150,5,34],[228,7,36],[306,9,38],[384,11,40]]; for (const [r,n,rad] of rows) for (let k=0;k<n;k++){ const a=(190+160*k/(n-1))*Math.PI/180; if (Math.abs(a*180/Math.PI-270)<8) continue; s+=`<circle cx="${(512+r*Math.cos(a)).toFixed(1)}" cy="${(600+r*Math.sin(a)).toFixed(1)}" r="${rad}" fill="#F7F6F2"/>`; } return s+`<rect x="387" y="634" width="250" height="68" rx="20" fill="#D9A441"/>`; })();

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const [name, w, h] of [["square", 1080, 1080], ["story", 1080, 1920]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.setContent(html(w, h), { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const file = `${out}/${voteId}-${name}.png`;
  await page.screenshot({ path: file }); console.log("wrote", file);
}
await browser.close();
