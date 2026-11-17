// Matching picks to games and taking price snapshots – used by record.js (post-time snapshot) and watch.js (close).
'use strict';
const L = require('./lib');

// ---- games list per league (Odds API events are free; ESPN is the no-key fallback)
async function oddsEvents(lg, h, cache) {
  const k = 'o:' + lg; if (cache[k]) return cache[k];
  try { cache[k] = await L.oddsapi.events(lg, h); h.fails.oddsapi = 0; }
  catch (e) { h.fails.oddsapi = (h.fails.oddsapi || 0) + 1; h.last_oddsapi_error = e.message; L.note(h, 'odds api events: ' + e.message); cache[k] = null; }
  return cache[k];
}
async function espnBoard(lg, from, to, h, cache) {   // from/to: Eastern dates YYYY-MM-DD
  const k = `e:${lg}:${from}:${to || ''}`; if (cache[k]) return cache[k];
  try { cache[k] = await L.espn.board(lg, from, to); h.fails.espn = 0; }
  catch (e) {
    h.fails.espn = (h.fails.espn || 0) + 1; h.last_espn_error = e.message; L.note(h, 'espn: ' + e.message);
    if (to) {   // a date range failed – fall back to single days
      const out = []; for (let d = from; d <= to && out.length < 800; d = L.addDays(d, 1)) out.push(...(await espnBoard(lg, d, null, h, cache) || []));
      return (cache[k] = out);
    }
    cache[k] = null;
  }
  return cache[k];
}
const etDate = t => L.localDate(t, 'America/New_York');

// ---- match picks without a game yet
async function matchPicks(picks, h, cache = {}) {
  let n = 0;
  for (const p of picks) {
    if (p.event || !p.market) continue;
    const posted = Date.parse(p.posted_at) || Date.now();
    const leagues = p.league ? [p.league] : ['nfl', 'ncaaf', 'nhl', 'nba', 'ncaab'];
    let found = null, ambiguous = false;
    for (const lg of leagues) {
      let evs = L.KEY ? await oddsEvents(lg, h, cache) : null;
      if (!evs) { const d0 = etDate(Math.min(posted, Date.now())); evs = await espnBoard(lg, L.addDays(d0, -1), L.addDays(d0, 7), h, cache) || []; }
      const e = L.bestEvent(p, evs, posted);
      if (e?.ambiguous) { ambiguous = true; continue; }
      if (e) { found = { lg, e }; break; }
    }
    p.match_tries = (p.match_tries || 0) + 1;
    if (!found) { p.match_error = ambiguous ? 'two games fit – send league and both teams' : 'no game found'; continue; }
    const { lg, e } = found, side = L.sideKey(p, e);
    if (!side) { p.match_error = `can't tell which team "${p.side}" is`; continue; }
    p.league = lg;
    p.event = { [e.src === 'espn' ? 'espn_id' : 'odds_id']: e.id, commence: e.commence, home: e.home.names[0], away: e.away.names[0], side };
    delete p.match_error; n++;
  }
  return n;
}

// ---- ESPN game for an already-matched pick (grading, fallback lines)
async function espnFor(p, h, cache) {
  const d = etDate(p.event.commence);
  const evs = await espnBoard(p.league, d, null, h, cache) || [];
  let e = p.event.espn_id && evs.find(x => x.id === p.event.espn_id);
  if (!e) {
    const q = { ...p, game: `${p.event.away} @ ${p.event.home}`, start_hint: p.event.commence, market: 'totals' };
    e = L.bestEvent(q, evs, Date.parse(p.event.commence));
    if (e && !e.ambiguous) p.event.espn_id = e.id; else e = null;
  }
  return e || null;
}

// ---- snapshots. kind = 'open' (post time) or 'close'. Odds API first (all books + Pinnacle), ESPN DraftKings line as fallback.
async function snapshot(picks, kind, h, cache = {}) {
  let n = 0;
  for (const [lg, ps] of L.groupBy(picks.filter(p => p.event && p.market), p => p.league)) {
    const lowOnCredits = kind === 'open' && h.credits && h.credits.remaining < L.OPEN_RESERVE;
    if (L.KEY && !lowOnCredits) {
      try {
        const game = ps.filter(p => !p.market.startsWith('player_') && p.event.odds_id);
        if (game.length) {
          const evs = await L.oddsapi.odds(lg, L.uniq(game.map(p => p.market)), L.uniq(game.map(p => p.event.odds_id)), h);
          for (const p of game) { const ev = evs.find(e => e.id === p.event.odds_id); const s = ev && L.snap(p, L.booksFromOddsApi(ev), 'oddsapi'); if (s) { p[kind] = s; n++; } }
        }
        for (const [id, props] of L.groupBy(ps.filter(p => p.market.startsWith('player_') && p.event.odds_id), p => p.event.odds_id)) {
          const ev = await L.oddsapi.eventOdds(lg, id, L.uniq(props.map(p => p.market)), h);
          for (const p of props) { const s = L.snap(p, L.booksFromOddsApi(ev), 'oddsapi'); if (s) { p[kind] = s; n++; } }
        }
        h.fails.oddsapi = 0;
      } catch (e) { h.fails.oddsapi = (h.fails.oddsapi || 0) + 1; h.last_oddsapi_error = e.message; L.note(h, `odds api ${kind}: ${e.message}`); }
    }
    for (const p of ps.filter(p => !p[kind] && !p.market.startsWith('player_'))) {   // ESPN: DraftKings, free
      const e = await espnFor(p, h, cache);
      const lines = e?.lines?.close;   // before kickoff ESPN's "close" is the current line
      const s = lines && L.snap(p, { [e.odds_book || 'draftkings']: lines }, 'espn');
      if (s) { p[kind] = s; n++; }
    }
  }
  return n;
}

// After kickoff: ESPN keeps the closing DraftKings line on the game, so a missed close can still be filled in.
async function lateClose(p, h, cache) {
  const e = await espnFor(p, h, cache);
  if (!e?.lines?.close || e.state === 'pre') return null;
  const s = L.snap(p, { [e.odds_book || 'draftkings']: e.lines.close }, 'espn-late');
  return s;
}

// Fresh start time just before the close (games get moved). Free on both sources.
async function refreshStart(p, h, cache) {
  if (L.KEY && p.event.odds_id) {
    const evs = await oddsEvents(p.league, h, cache);
    const e = evs && evs.find(x => x.id === p.event.odds_id);
    if (e) return e.commence;
  }
  const e = await espnFor(p, h, cache);
  return e ? e.commence : null;
}

module.exports = { matchPicks, snapshot, lateClose, refreshStart, espnFor };
