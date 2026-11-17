// CLV watcher (clv-watch.yml). One cycle: match new picks → take the closing price ~8 minutes before each start →
// score CLV → grade finished games from ESPN → self-checks → weekly summary (Mondays) → REPORT.md.
//   node watch.js           one cycle
//   node watch.js --loop    keeps cycling (every ≤4 min, sleeps through quiet hours) while any close is coming up;
//                           commits after each change; hands over to a fresh run before GitHub's 6-hour job limit.
'use strict';
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const L = require('./lib'), E = require('./engine');

const CLOSE_LEAD = 8 * 60e3;        // take the close this long before the start
const GRADE_EVERY = 30 * 60e3;
const LOOP = process.argv.includes('--loop');
const LOOP_MAX = (+process.env.CLV_LOOP_MIN || 330) * 60e3;
const REPORT = process.env.CLV_REPORT || path.join(__dirname, 'REPORT.md');
const started = Date.now();

const sh = (c, quiet) => { try { return execSync(c, { stdio: quiet ? 'pipe' : 'inherit', cwd: path.join(__dirname, '..') })?.toString() || ''; } catch (e) { return null; } };
const gameEnd = p => Date.parse(p.event.commence) + (L.LEAGUES[p.league]?.hours || 3.5) * 3600e3;

async function cycle(h) {
  const now = Date.now(), picks = L.loadPicks(), dirty = new Set(), cache = {};
  const touch = p => dirty.add(p);
  h.last_cycle = new Date().toISOString();

  // 1. picks still without a game (record-time match failed) – retry, give up after the game day
  const unmatched = picks.filter(p => !p.event && p.status === 'open' && p.market && (p.match_tries || 0) < 12);
  if (unmatched.length) {
    await E.matchPicks(unmatched, h, cache); unmatched.forEach(touch);
    for (const p of unmatched.filter(p => !p.event && (p.match_tries >= 3 || p.date < L.localDate(now)))) {
      L.dm(h, 'unmatched:' + p.id, `⚠ **CLV tracker** can't find the game for ${p.source} pick "${L.pickLabel(p)}" (${p.game || 'no game given'}): ${p.match_error}. It won't get a CLV score.`);
      if (p.date < L.addDays(L.localDate(now), -1)) { p.status = 'unmatched'; }
    }
  }

  // 2. closes due
  const due = picks.filter(p => p.event && !p.close && p.status === 'open' && now >= Date.parse(p.event.commence) - CLOSE_LEAD - 2 * 60e3);
  const pre = [], late = [];
  for (const p of due) {
    if (now < Date.parse(p.event.commence) + 2 * 60e3) {
      const t = await E.refreshStart(p, h, cache).catch(() => null);
      if (t && Math.abs(Date.parse(t) - Date.parse(p.event.commence)) >= 30e3) { L.note(h, `${p.id}: start moved to ${t}`); p.event.commence = t; touch(p); }
      if (now >= Date.parse(p.event.commence) - CLOSE_LEAD - 2 * 60e3) pre.push(p);
    } else late.push(p);
  }
  if (pre.length) { await E.snapshot(pre, 'close', h, cache); pre.forEach(touch); }
  for (const p of late) {
    const s = await E.lateClose(p, h, cache).catch(() => null);
    if (s) { p.close = s; touch(p); L.note(h, `${p.id}: close filled in after the start from ESPN`); continue; }
    if (now > Date.parse(p.event.commence) + 30 * 60e3) {
      const giveUp = now > gameEnd(p) + 6 * 3600e3 || p.market.startsWith('player_');
      if (giveUp) { p.close = null; p.close_missed = true; p.status = 'closed'; touch(p); }
      L.dm(h, 'close-miss:' + p.id, `⚠ **CLV tracker** missed the closing price for ${p.source} pick "${L.pickLabel(p)}" (${p.event.away} @ ${p.event.home}).` +
        (giveUp ? ' It stays unscored.' : ' Still trying ESPN\'s closing line.') + (h.last_oddsapi_error ? ` Last Odds API error: ${h.last_oddsapi_error.slice(0, 120)}` : ''));
    }
  }

  // 3. score
  for (const p of picks.filter(p => p.close && !p.clv)) { p.clv = L.scoreClv(p); if (p.status === 'open') p.status = 'closed'; touch(p); }

  // 4. grade game lines from ESPN final scores (every 30 min per pick once the game should be over)
  for (const p of picks.filter(p => p.event && p.result === 'pending' && !p.market.startsWith('player_') && now > gameEnd(p) && now - (Date.parse(p.grade_try_at) || 0) > GRADE_EVERY)) {
    p.grade_try_at = new Date().toISOString(); touch(p);
    const e = await E.espnFor(p, h, cache);
    const g = L.grade(p, e);
    if (g) { Object.assign(p, g, { status: 'graded', result_src: 'espn' }); p.profit = L.profit(p); L.note(h, `${p.id}: ${g.result} (${g.score})`); }
    else if (e && /postponed|canceled|cancelled/i.test(e.status)) { p.result = 'void'; p.status = 'graded'; p.profit = 0; }
    else if (now > gameEnd(p) + 30 * 3600e3) L.dm(h, 'grade-stuck:' + p.id, `⚠ **CLV tracker** can't find a final score for "${L.pickLabel(p)}" (${p.event.away} @ ${p.event.home}). Settle it by hand with clv-record: {"id":"${p.id}","result":"win"}.`);
  }

  // 5. self-checks
  if (L.KEY) {
    if ((h.fails.oddsapi || 0) >= 3) L.dm(h, 'oddsapi-down', `⚠ **CLV tracker**: The Odds API keeps failing (${(h.last_oddsapi_error || '').slice(0, 140)}). Using ESPN's DraftKings lines until it's back.`);
    else if (!h.fails.oddsapi && h.alerted['oddsapi-down']) { delete h.alerted['oddsapi-down']; L.dm(h, null, '✅ **CLV tracker**: The Odds API is working again.'); }
    const month = L.localDate(now).slice(0, 7);
    if (h.credits && h.credits.remaining < L.LOW_CREDITS) L.dm(h, 'credits:' + month, `⚠ **CLV tracker**: only ${h.credits.remaining} Odds API credits left this month. Closes fall back to ESPN's DraftKings line (no Pinnacle, no props) until the 1st.`);
  }
  if ((h.fails.espn || 0) >= 6) L.dm(h, 'espn-down', `⚠ **CLV tracker**: ESPN's scoreboard keeps failing (${(h.last_espn_error || '').slice(0, 140)}), so grading is paused.`);
  else if (!h.fails.espn && h.alerted['espn-down']) delete h.alerted['espn-down'];

  // 6. weekly summary, Monday after 8 AM
  const today = L.localDate(now), dow = new Date(today + 'T12:00:00Z').getUTCDay();
  if (dow === 1 && L.localHM() >= 800 && h.weekly !== today) {
    h.weekly = today; dirty.add('health');
    const from = L.addDays(today, -7);
    const week = picks.filter(p => p.date >= from && p.date < today && p.status !== 'unmatched');
    if (week.length) {
      const lines = [`📈 **CLV week of ${from.slice(5)} to ${L.addDays(today, -1).slice(5)}**`];
      for (const [src, ps] of [...L.groupBy(week, p => p.source)].sort()) lines.push(`*${src}*: ${L.statLine(L.stats(ps))}`);
      const allTime = L.groupBy(picks.filter(p => p.status !== 'unmatched'), p => p.source);
      lines.push('All time: ' + [...allTime].sort().map(([s, ps]) => { const x = L.stats(ps); return `${s} ${x.scored ? Math.round(x.beatRate * 100) + '% beat, ' + L.pct(x.avgClv) : '–'}`; }).join(' · '));
      L.dm(h, null, lines.join('\n'));
    }
  }

  for (const p of dirty) if (p !== 'health' && !L.DRY) L.savePick(p);
  if (dirty.size) writeReport(L.loadPicks());
  return { changed: dirty.size > 0, picks: L.loadPicks() };
}

function writeReport(picks) {
  if (L.DRY) return;
  picks = picks.filter(p => p.status !== 'unmatched').sort((a, b) => (b.event?.commence || b.posted_at).localeCompare(a.event?.commence || a.posted_at));
  const by = [...L.groupBy(picks, p => p.source)].sort(), wk = L.addDays(L.localDate(Date.now()), -7);
  const row = (name, s) => `| ${name} | ${s.n} | ${s.scored ? `${s.beat}/${s.scored} (${Math.round(s.beatRate * 100)}%)` : '–'} | ${L.pct(s.avgClv)} | ${s.w}-${s.l}-${s.p} | ${s.units >= 0 ? '+' : ''}${s.units}u | ${s.roi == null ? '–' : L.pct(s.roi)} |`;
  const md = ['# Closing line value', '', `Updated ${new Date().toLocaleString('en-US', { timeZone: L.TZ })} (Denver). CLV = expected value of the pick price against the no-vig closing line (Pinnacle when it has the same number, else the reference book); "beat" = better price or better number than the close at your book (DraftKings when your book isn't covered).`, '',
    '| Source | Picks | Beat the close | Avg CLV | W-L-P | Units | ROI |', '|---|---|---|---|---|---|---|',
    ...by.map(([s, ps]) => row(s + ' (all)', L.stats(ps))), ...by.map(([s, ps]) => row(s + ' (7 days)', L.stats(ps.filter(p => p.date >= wk)))), '',
    '| Date | Source | Pick | Price | Close (ref book) | CLV | Beat | Result |', '|---|---|---|---|---|---|---|---|',
    ...picks.slice(0, 60).map(p => `| ${p.date} | ${p.source} | ${L.pickLabel(p)}${p.event ? ` (${p.event.away} @ ${p.event.home})` : ''} | ${L.fmtA(p.price)} ${p.book_name} | ${p.clv ? `${L.fmtA(p.clv.close_price)}${p.clv.close_point != null ? ' at ' + p.clv.close_point : ''} (${p.clv.ref}${p.close?.src === 'espn' || p.close?.src === 'espn-late' ? ', ESPN' : ''})` : p.close_missed ? 'missed' : 'pending'} | ${p.clv ? (p.clv.points ? `${p.clv.points > 0 ? '+' : ''}${p.clv.points} pts${p.clv.clv != null ? ' (~' + L.pct(p.clv.clv) + ')' : ''}` : L.pct(p.clv.clv)) : '–'} | ${p.clv ? (p.clv.beat ? '✅' : '❌') : '–'} | ${p.result}${p.score ? ' ' + p.score : ''} |`), ''];
  fs.writeFileSync(REPORT, md.join('\n'));
}

// what's the next thing worth waking up for?
function nextWake(picks, now) {
  let t = Infinity;
  for (const p of picks) {
    if (p.event && !p.close && p.status === 'open') { const c = Date.parse(p.event.commence); t = Math.min(t, now > c + 2 * 60e3 ? now + 10 * 60e3 : Math.max(now, c - CLOSE_LEAD)); }   // after the start: ESPN late-close retries every 10 min
    if (p.event && p.result === 'pending' && !p.market.startsWith('player_') && now < gameEnd(p) + 36 * 3600e3) t = Math.min(t, Math.max(gameEnd(p), (Date.parse(p.grade_try_at) || 0) + GRADE_EVERY));
    if (!p.event && p.status === 'open' && (p.match_tries || 0) < 12) t = Math.min(t, now + 30 * 60e3);
  }
  return t;
}
const quiet = (t = Date.now()) => { const hm = L.localHM(new Date(t)); return hm >= 2200 || hm < 500; };

function commit(msg) {
  if (L.DRY || !process.env.GITHUB_ACTIONS) return;
  sh('git add clv/data clv/REPORT.md');
  if (sh('git diff --cached --quiet', true) !== null) return;   // nothing staged
  sh(`git commit -q -m "${msg}"`);
  for (let i = 1; i <= 4; i++) { if (sh('git pull --rebase -q -X theirs') !== null && sh('git push -q') !== null) return; execSync(`sleep ${i * 5}`); }
  console.log('::warning::push failed');
}

async function main() {
  const h = L.loadHealth();
  if (!LOOP) { await cycle(h); if (!L.DRY) L.saveHealth(h); commit('clv: update'); return; }
  let lastSave = 0;
  for (;;) {
    if (process.env.GITHUB_ACTIONS) sh('git pull --rebase -q -X theirs', true);
    const hr = L.loadHealth(L.HEALTH_REC); if (hr.credits && (!h.credits || hr.credits.at > h.credits.at)) h.credits = hr.credits;   // record runs spend credits too
    const r = await cycle(h);
    if (r.changed || h._dirty || Date.now() - lastSave > 60 * 60e3) { if (!L.DRY) L.saveHealth(h); lastSave = Date.now(); commit('clv: ' + (r.changed ? 'update' : 'heartbeat')); }
    const now = Date.now(), wake = nextWake(r.picks, now);
    if (wake === Infinity || wake - now > 20 * 3600e3) { console.log('Nothing coming up – done.'); break; }
    if (now - started > LOOP_MAX) {   // hand over before the 6-hour job limit
      for (let i = 1; i <= 5; i++) { if (sh(`gh workflow run clv-watch.yml -R ${process.env.GITHUB_REPOSITORY} --ref main`) !== null) break; execSync(`sleep ${i * 15}`); }
      console.log('Handed over to the next run.'); break;
    }
    // poll every 4 min in the day (new picks arrive by git); in quiet hours sleep until 5 AM or the next close
    let until = Math.min(wake, now + 4 * 60e3);
    if (quiet(now) && wake > now + 4 * 60e3) { let t = now; while (quiet(t) && t < wake) t += 5 * 60e3; until = Math.min(wake, t); }
    until = Math.min(until, started + LOOP_MAX + 30e3);
    const ms = Math.max(20e3, until - Date.now());
    console.log(`next look ${new Date(Date.now() + ms).toISOString()} (next due ${wake === Infinity ? 'none' : new Date(wake).toISOString()})`);
    await L.sleep(ms);
  }
  if (!L.DRY) L.saveHealth(h); commit('clv: update');
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { cycle, nextWake, writeReport };
