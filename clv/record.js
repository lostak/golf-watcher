// Records picks for CLV tracking (clv-record.yml). Input: PICKS env = JSON array (or one object, or one JSON object per line).
//   [{"league":"nfl","game":"Broncos @ Chiefs","market":"spread","side":"Broncos","line":3.5,"price":-110,"book":"DraftKings","units":1}]
// Settle a prop by hand: [{"id":"<pick id>","result":"win|loss|push|void"}]. SOURCE env (duet | life | …) applies to picks without one.
// Same pick sent twice = recorded once. Takes a post-time price snapshot when it can (never fails the run for that).
'use strict';
const fs = require('fs');
const L = require('./lib'), E = require('./engine');

function readInput(txt) {
  txt = String(txt || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!txt) throw new Error('no picks given');
  try { const j = JSON.parse(txt); return Array.isArray(j) ? j : Array.isArray(j.picks) ? j.picks : [j]; }
  catch { return txt.split('\n').map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s)); }
}

(async () => {
  const h = L.loadHealth(L.HEALTH_REC), out = [], problems = [];
  const hw = L.loadHealth(); if (hw.credits && (!h.credits || hw.credits.at > h.credits.at)) h.credits = hw.credits;   // budget check uses the newest count
  let items;
  try { items = readInput(process.env.PICKS ?? process.argv[2]); }
  catch (e) { problems.push(`couldn't read the picks: ${e.message}`); items = []; }
  const fresh = [];
  for (const raw of items) {
    if (raw && raw.id && raw.result && !raw.game) {   // manual settle
      const f = L.readJSON(L.pickFile(String(raw.id).replace(/[^a-z0-9_.+-]/gi, '')), null);
      const r = String(raw.result).toLowerCase();
      if (!f) problems.push(`no pick with id ${raw.id}`);
      else if (!['win', 'loss', 'push', 'void'].includes(r)) problems.push(`result must be win, loss, push or void (got ${raw.result})`);
      else { f.result = r; f.result_src = 'manual'; f.profit = L.profit(f); f.status = 'graded'; L.savePick(f); out.push(`settled ${f.id}: ${r}`); }
      continue;
    }
    const { pick, errs } = L.parsePick(raw, process.env.SOURCE);
    if (errs.length) { problems.push(`${raw?.game || raw?.side || JSON.stringify(raw).slice(0, 60)}: ${errs.join(', ')}`); continue; }
    if (L.readJSON(L.pickFile(pick.id), null)) { out.push(`already recorded: ${pick.id}`); continue; }
    pick.posted_at = new Date().toISOString(); pick.status = 'open'; pick.result = 'pending';
    fresh.push(pick);
  }
  const cache = {};
  if (fresh.length) {
    try { await E.matchPicks(fresh, h, cache); } catch (e) { L.note(h, 'match: ' + e.message); }
    try { await E.snapshot(fresh.filter(p => p.event && Date.parse(p.event.commence) > Date.now()), 'open', h, cache); } catch (e) { L.note(h, 'open snapshot: ' + e.message); }
    for (const p of fresh) {
      if (!L.DRY) L.savePick(p);
      const o = p.open && (p.open.books[p.book] || Object.values(p.open.books)[0]);
      out.push(`recorded ${p.id} – ${L.pickLabel(p)} ${L.fmtA(p.price)} @ ${p.book_name}` +
        (p.event ? ` · ${p.event.away} @ ${p.event.home}, ${L.when(p.event.commence)}` : ` · game not matched yet (${p.match_error}); will retry`) +
        (o ? ` · market now ${L.fmtA(o[0])}${o[1] != null ? ' at ' + o[1] : ''} (${p.open.src})` : ''));
    }
  }
  if (!L.DRY) L.saveHealth(h, L.HEALTH_REC);
  const text = [...out, ...problems.map(x => 'PROBLEM: ' + x)].join('\n') || 'nothing to do';
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + text + '\n```\n');
  if (problems.length) {
    // the caller (a Claude routine) only sees "dispatched", so Bradley hears about rejected picks here
    L.dm(h, null, `⚠ **CLV tracker** couldn't record ${problems.length} pick${problems.length > 1 ? 's' : ''}:\n` + problems.map(x => '• ' + x).join('\n').slice(0, 1500));
    if (!L.DRY) L.saveHealth(h, L.HEALTH_REC);
    process.exitCode = items.length && fresh.length + out.length ? 0 : 2;
  }
})().catch(e => { console.error(e); process.exit(1); });
