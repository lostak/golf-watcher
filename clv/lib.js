// Closing-line-value (CLV) tracker – shared code. No npm packages: Node 20+ fetch only.
// Sources: The Odds API (free key, 500 credits/month: DraftKings, FanDuel, BetMGM, Pinnacle … and player props) when the
// ODDS_API_KEY secret is set, and ESPN's public scoreboard (no key, unlimited: DraftKings open/close lines + final scores)
// for everything else and as the fallback whenever The Odds API fails or runs low.
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');

const TZ = 'America/Denver';
const DATA = process.env.CLV_DATA || path.join(__dirname, 'data');
const PICKS = path.join(DATA, 'picks'), HEALTH = path.join(DATA, 'health.json'), HEALTH_REC = path.join(DATA, 'health-record.json');   // separate files so the two workflows never edit the same one
const one = v => String(v || '').split(/\s+/).filter(Boolean)[0] || '';   // secrets pasted with a stray line break
const KEY = one(process.env.ODDS_API_KEY);
const DRY = process.argv.includes('--dry') || process.env.CLV_DRY === '1';
const OPEN_RESERVE = 150;   // below this many Odds API credits left, post-time snapshots use ESPN so closes keep priority
const LOW_CREDITS = 40;     // below this, Bradley gets one DM for the month

// ---------------------------------------------------------------- leagues, books, markets
const LEAGUES = {
  nfl: { odds: 'americanfootball_nfl', espn: 'football/nfl', hours: 3.4 },
  ncaaf: { odds: 'americanfootball_ncaaf', espn: 'football/college-football', groups: '80', hours: 3.6 },
  nhl: { odds: 'icehockey_nhl', espn: 'hockey/nhl', hours: 2.8 },
  nba: { odds: 'basketball_nba', espn: 'basketball/nba', hours: 2.6 },
  ncaab: { odds: 'basketball_ncaab', espn: 'basketball/mens-college-basketball', groups: '50', hours: 2.4 },
  mlb: { odds: 'baseball_mlb', espn: 'baseball/mlb', hours: 3.3 },
};
const LEAGUE_ALIAS = { cfb: 'ncaaf', 'college football': 'ncaaf', ncaafb: 'ncaaf', ncaa: 'ncaaf', 'ncaa football': 'ncaaf', football: 'nfl', hockey: 'nhl',
  'college basketball': 'ncaab', cbb: 'ncaab', basketball: 'nba', baseball: 'mlb', americanfootball_nfl: 'nfl', americanfootball_ncaaf: 'ncaaf', icehockey_nhl: 'nhl' };
const leagueOf = s => { const k = norm(s); return LEAGUES[k] ? k : LEAGUE_ALIAS[k] || null; };

const BOOKS = { draftkings: 'draftkings', dk: 'draftkings', fanduel: 'fanduel', fd: 'fanduel', betmgm: 'betmgm', mgm: 'betmgm',
  caesars: 'williamhill_us', williamhill: 'williamhill_us', pinnacle: 'pinnacle', pinny: 'pinnacle', bet365: 'bet365', betrivers: 'betrivers',
  espnbet: 'espnbet', fanatics: 'fanatics', hardrock: 'hardrockbet', hardrockbet: 'hardrockbet', ballybet: 'ballybet', betonline: 'betonlineag', lowvig: 'lowvig' };
const bookKey = s => { const k = norm(s).replace(/ /g, '').replace(/sportsbook$/, ''); return BOOKS[k] || k || 'unknown'; };
// Up to 10 bookmakers cost the same as one region. bet365 has no US feed on The Odds API, so bet365 picks are scored against
// the next book in REF_ORDER (DraftKings first).
const FETCH_BOOKS = (process.env.ODDS_BOOKS || 'draftkings,fanduel,betmgm,betrivers,pinnacle,lowvig,betonlineag').split(',').map(s => s.trim()).filter(Boolean);
const SAFE_BOOKS = ['draftkings', 'fanduel', 'pinnacle'];
const REF_ORDER = ['draftkings', 'fanduel', 'betmgm', 'betrivers', 'pinnacle'];
const SHARP = ['pinnacle', 'lowvig', 'betonlineag'];

// Odds API player-prop market keys, by stat words he might write
const PROPS = [
  [/anytime\s*(td|touchdown)/, 'player_anytime_td'], [/(1st|first)\s*(td|touchdown)/, 'player_1st_td'],
  [/pass(ing)?\s*(yds|yards)/, 'player_pass_yds'], [/pass(ing)?\s*(tds?|touchdowns?)/, 'player_pass_tds'],
  [/(completions|comp)/, 'player_pass_completions'], [/(interceptions|ints?)\b/, 'player_pass_interceptions'],
  [/rush(ing)?\s*(yds|yards)/, 'player_rush_yds'], [/rush(ing)?\s*(att|attempts)/, 'player_rush_attempts'],
  [/(rec|receiving|reception)\s*(yds|yards)/, 'player_reception_yds'], [/receptions|catches/, 'player_receptions'],
  [/anytime\s*goal|goal\s*scorer/, 'player_goal_scorer_anytime'], [/shots?(\s*on\s*goal)?|sog/, 'player_shots_on_goal'],
  [/saves/, 'player_total_saves'], [/pra|points\s*rebounds\s*assists/, 'player_points_rebounds_assists'],
  [/threes|3pt|3-pointers/, 'player_threes'], [/rebounds|rebs?/, 'player_rebounds'], [/assists|ast/, 'player_assists'],
  [/goals/, 'player_goals'], [/points|pts/, 'player_points'],
];

// ---------------------------------------------------------------- odds math
const american = v => {   // "-110", "+150", 150, "EVEN", decimal 2.5 → American number (or NaN)
  if (v == null || v === '') return NaN;
  let s = String(v).trim().toLowerCase();
  if (s === 'even' || s === 'ev') return 100;
  s = s.replace(/^\+/, ''); const n = Number(s);
  if (!isFinite(n)) return NaN;
  if (Math.abs(n) >= 100) return Math.round(n);
  if (n > 1 && n < 50) return toAmerican(n);   // decimal odds
  return NaN;
};
const dec = a => a > 0 ? 1 + a / 100 : 1 + 100 / -a;
const imp = a => 1 / dec(a);
const toAmerican = d => d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
const fmtA = a => isFinite(a) ? (a > 0 ? '+' + a : String(a)) : '?';
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/^[ou]/i, '').replace(/^\+/, '')); return isFinite(n) ? n : null; };
const pct = x => x == null || !isFinite(x) ? '–' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';

// ---------------------------------------------------------------- text + time helpers
const norm = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/\bst\.?\b/g, 'state')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const slug = s => norm(s).replace(/ /g, '-').slice(0, 40);
const localDate = (d, tz = TZ) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
const localHM = (d = new Date(), tz = TZ) => +new Date(d).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(':', '');
const addDays = (ymd, n) => { const x = new Date(ymd + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const when = d => new Date(d).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const uniq = a => [...new Set(a)];
const groupBy = (a, f) => a.reduce((m, x) => { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); return m; }, new Map());
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- storage: one JSON file per pick (so the record and
// watch workflows never edit the same file and git rebases stay clean)
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); };
const pickFile = id => path.join(PICKS, id + '.json');
const loadPicks = () => { try { return fs.readdirSync(PICKS).filter(f => f.endsWith('.json')).map(f => readJSON(path.join(PICKS, f), null)).filter(Boolean); } catch { return []; } };
const savePick = p => writeJSON(pickFile(p.id), p);
const loadHealth = (f = HEALTH) => { const h = readJSON(f, {}); h.fails ||= {}; h.alerted ||= {}; h.log ||= []; return h; };
const saveHealth = (h, f = HEALTH) => { delete h._dirty; h.log = h.log.slice(-40); writeJSON(f, h); };
const note = (h, msg) => { const line = new Date().toISOString().slice(0, 16) + 'Z ' + msg; console.log(line); h && h.log.push(line); };

// ---------------------------------------------------------------- reading a pick (lenient: whatever the Duet or Life routine sends)
function parsePick(raw, source) {
  const r = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const errs = [];
  const p = { source: norm(r.source || source || 'duet').replace(/ /g, '-') || 'duet' };
  p.league = leagueOf(r.league || r.sport) || null;
  p.game = String(r.game || r.matchup || r.event || '').trim();
  let side = String(r.side ?? r.pick ?? r.selection ?? r.bet ?? '').trim();
  let mk = norm(r.market || r.type || r.bet_type || '');
  p.player = r.player ? String(r.player).trim() : null;
  p.price = american(r.price ?? r.odds);
  p.book = bookKey(r.book || r.sportsbook || 'draftkings');
  p.book_name = String(r.book || r.sportsbook || 'DraftKings');
  p.units = num(r.units ?? r.stake) ?? 1;
  if (r.confidence != null) p.confidence = r.confidence;
  if (r.why) p.why = String(r.why).slice(0, 300);
  p.date = /^\d{4}-\d\d-\d\d$/.test(String(r.date || '')) ? String(r.date) : localDate(Date.now());
  if (r.start || r.commence_time || r.kickoff) { const t = Date.parse(r.start || r.commence_time || r.kickoff); if (isFinite(t)) p.start_hint = new Date(t).toISOString(); }
  if (r.event_id) p.event_hint = String(r.event_id);
  let line = num(r.line ?? r.point ?? r.spread ?? r.total);
  // "Broncos +3.5", "Over 44.5", "o44.5", "Broncos ML", "Chiefs -150" (price written into the side)
  const m = side.match(/^(.*?)\s*([ou]?)([+-]?\d+(?:\.\d+)?)$/i);
  if (/\b(ml|moneyline|money line)\b/i.test(side)) { side = side.replace(/\b(ml|moneyline|money line)\b/ig, '').trim(); mk ||= 'moneyline'; }
  else if (m && m[1] && !/^(over|under)$/i.test(m[1].trim()) && !m[2] && Math.abs(+m[3]) >= 100 && !isFinite(p.price)) { side = m[1].trim(); p.price = american(m[3]); mk ||= 'moneyline'; }
  else if (m && (m[1] || m[2])) {
    const head = m[1].trim(), n = +m[3];
    if (m[2] || /^(over|under|o|u)$/i.test(head)) { side = /^u/i.test(m[2] || head) ? 'under' : 'over'; line ??= Math.abs(n); mk ||= 'total'; }
    else if (!/prop/.test(mk) && Math.abs(n) < 100) { side = head; line ??= n; mk ||= 'spread'; }
  }
  if (/^(o|over)\b/i.test(side) && !p.player) { mk ||= 'total'; }
  p.side = side;
  const stat = norm(r.stat || r.prop || r.prop_type || '');
  if (r.prop_market) p.market = String(r.prop_market).trim();
  else if (/prop|player/.test(mk) || p.player || stat) { const hit = PROPS.find(([re]) => re.test(stat || mk)); p.market = hit ? hit[1] : null; if (!hit) errs.push('prop stat not recognised (send prop_market, e.g. player_pass_yds)'); }
  else if (/^(ml|moneyline|money line|h2h|win|to win)$/.test(mk)) p.market = 'h2h';
  else if (/spread|ats|puck|run line|handicap|line/.test(mk)) p.market = 'spreads';
  else if (/total|o u|over|under/.test(mk)) p.market = 'totals';
  else if (!mk && line == null) p.market = 'h2h';
  else { p.market = null; errs.push(`market "${r.market || ''}" not recognised (moneyline, spread, total or prop)`); }
  p.line = p.market === 'h2h' ? null : line;
  if (p.market && p.market !== 'h2h' && p.line == null && !/anytime|1st_td|goal_scorer/.test(p.market)) errs.push('missing line');
  if (p.market === 'totals' || (p.market || '').startsWith('player_')) {
    const s = norm(side); p.side = /^(u|under)\b/.test(s) ? 'under' : /^(o|over)\b/.test(s) ? 'over' : /^(no)\b/.test(s) ? 'no' : (p.market || '').startsWith('player_') && (/^(yes)\b/.test(s) || !s || norm(p.player || '') && s.includes(norm(p.player).split(' ').pop())) ? (/anytime|1st_td|goal_scorer/.test(p.market) ? 'yes' : 'over') : s;
    if (p.market === 'totals' && !/^(over|under)$/.test(p.side)) errs.push('total side must be over or under');
  }
  if (!p.game && !p.side) errs.push('missing game');
  if (!isFinite(p.price)) errs.push('missing or bad price');
  if ((p.market || '').startsWith('player_') && !p.player) errs.push('prop needs player');
  const key = [p.date, p.source, slug(p.game || p.side), p.market, slug(p.player || ''), slug(p.side), p.line ?? ''].filter(x => x !== '').join('_');
  p.id = key.replace(/[^a-z0-9_.+-]/gi, '').replace(/_+/g, '_').slice(0, 150);
  return { pick: p, errs };
}

// ---------------------------------------------------------------- matching picks to games
const STOP = new Set(['the', 'of', 'at', 'vs', 'and', 'fc', 'u', 'university']);
function aliases(names) {
  const out = new Set();
  for (const n0 of names.filter(Boolean)) {
    const n = norm(n0), t = n.split(' ');
    out.add(n);
    if (t.length > 1) { out.add(t.slice(-1)[0]); out.add(t.slice(0, -1).join(' ')); }
    if (t.length > 2) { out.add(t.slice(-2).join(' ')); out.add(t.slice(0, -2).join(' ')); }
  }
  return [...out].filter(a => a.length >= 3 && !STOP.has(a));
}
function teamScore(q, als) {
  const qn = norm(q); if (!qn) return 0; const qt = new Set(qn.split(' ').filter(w => !STOP.has(w)));
  let best = 0;
  for (const a of als) {
    if (qn === a) best = Math.max(best, a.includes(' ') ? 10 : 9);
    else if (` ${qn} `.includes(` ${a} `)) best = Math.max(best, a.includes(' ') ? 7 : 6);
    else if (a.startsWith(qn + ' ')) best = Math.max(best, 5);
    else { const at = a.split(' '), hit = at.filter(w => qt.has(w)).length; if (hit) best = Math.max(best, 4 * hit / Math.max(at.length, qt.size)); }
  }
  return best;
}
// Event: { home:{names[]}, away:{names[]}, commence }. Returns score for the pick's game text + side.
function eventScore(p, ev) {
  const H = ev.home.als ||= aliases(ev.home.names), A = ev.away.als ||= aliases(ev.away.names);
  const parts = p.game.split(/\s+(?:@|at|vs\.?|v\.?|versus|-|–|\/)\s+|\s*@\s*/i).map(s => s.trim()).filter(Boolean);
  let g = 0;
  if (parts.length >= 2) g = Math.max(teamScore(parts[0], A) + teamScore(parts[1], H), teamScore(parts[0], H) + teamScore(parts[1], A));
  else if (parts.length === 1) g = teamScore(parts[0], H) + teamScore(parts[0], A);
  const s = ['h2h', 'spreads'].includes(p.market) ? Math.max(teamScore(p.side, H), teamScore(p.side, A)) : 0;
  return g + s * 0.5;
}
function bestEvent(p, events, postedAt = Date.now()) {
  const lo = (p.start_hint ? Date.parse(p.start_hint) - 6 * 3600e3 : postedAt - 4 * 3600e3), hi = p.start_hint ? Date.parse(p.start_hint) + 6 * 3600e3 : postedAt + 8 * 864e5;
  const sc = events.filter(e => { const t = Date.parse(e.commence); return t >= lo && t <= hi; })
    .map(e => ({ e, s: eventScore(p, e) })).filter(x => x.s >= 6).sort((a, b) => b.s - a.s || Date.parse(a.e.commence) - Date.parse(b.e.commence));
  if (!sc.length) return null;
  // two different games scoring the same on the same day = ambiguous
  if (sc[1] && sc[1].s >= sc[0].s - 0.5 && localDate(sc[1].e.commence) === localDate(sc[0].e.commence) && sc[1].e !== sc[0].e) return { ambiguous: true };
  return sc[0].e;
}
function sideKey(p, ev) {
  if (p.market === 'h2h' || p.market === 'spreads') {
    const H = ev.home.als ||= aliases(ev.home.names), A = ev.away.als ||= aliases(ev.away.names);
    const h = teamScore(p.side, H), a = teamScore(p.side, A);
    return h > a && h >= 3 ? 'home' : a > h && a >= 3 ? 'away' : null;
  }
  return p.side;   // over / under / yes / no
}

// ---------------------------------------------------------------- HTTP with retries
async function get(url, label, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'clv-tracker (github actions)', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return r;
      last = new Error(`${label} ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`); last.status = r.status;
      if (r.status < 500 && r.status !== 429) break;   // 401/404/422: retrying won't help
    } catch (e) { last = new Error(`${label} ${e.name === 'TimeoutError' ? 'timeout' : e.message}`); }
    if (i < tries - 1) await sleep(2000 * (i + 1) ** 2);
  }
  throw last;
}

// ---------------------------------------------------------------- The Odds API
const oddsapi = {
  ready: !!KEY,
  async call(p, params, h) {
    const qs = new URLSearchParams({ apiKey: KEY, ...params });
    const r = await get(`https://api.the-odds-api.com/v4/${p}?${qs}`, 'Odds API');
    const rem = r.headers.get('x-requests-remaining');
    if (h && rem != null) h.credits = { remaining: Math.floor(+rem), used: Math.floor(+r.headers.get('x-requests-used') || 0), last: +r.headers.get('x-requests-last') || 0, at: new Date().toISOString() };
    return r.json();
  },
  async events(lg, h) {   // free
    return (await this.call(`sports/${LEAGUES[lg].odds}/events`, { dateFormat: 'iso' }, h)).map(e => ({ src: 'oddsapi', id: e.id, commence: e.commence_time, home: { names: [e.home_team] }, away: { names: [e.away_team] }, raw: e }));
  },
  async odds(lg, markets, ids, h) {   // cost = number of markets (≤10 bookmakers = 1 region)
    const base = { markets: markets.join(','), oddsFormat: 'american', dateFormat: 'iso', eventIds: ids.join(',') };
    try { return await this.call(`sports/${LEAGUES[lg].odds}/odds`, { ...base, bookmakers: FETCH_BOOKS.join(',') }, h); }
    catch (e) { if (e.status !== 422) throw e; return this.call(`sports/${LEAGUES[lg].odds}/odds`, { ...base, bookmakers: SAFE_BOOKS.join(',') }, h); }   // an unknown book key – retry with the core three
  },
  async eventOdds(lg, id, markets, h) {   // player props, one game at a time; cost = markets returned
    const base = { markets: markets.join(','), oddsFormat: 'american', dateFormat: 'iso' };
    try { return await this.call(`sports/${LEAGUES[lg].odds}/events/${id}/odds`, { ...base, bookmakers: FETCH_BOOKS.join(',') }, h); }
    catch (e) { if (e.status !== 422) throw e; return this.call(`sports/${LEAGUES[lg].odds}/events/${id}/odds`, { ...base, bookmakers: SAFE_BOOKS.join(',') }, h); }
  },
};
// Odds API event → { book: { h2h:{home,away}, spreads:{home,away}, totals:{over,under}, props:[...] } }, each side {price, point}
function booksFromOddsApi(raw) {
  const out = {};
  for (const bk of raw.bookmakers || []) {
    const b = out[bk.key] = {};
    for (const m of bk.markets || []) {
      const side = o => o.name === raw.home_team ? 'home' : o.name === raw.away_team ? 'away' : norm(o.name);
      if (m.key.startsWith('player_')) (b.props ||= []).push(...m.outcomes.map(o => ({ market: m.key, player: o.description || '', side: norm(o.name), price: o.price, point: o.point ?? null })));
      else b[m.key] = Object.fromEntries(m.outcomes.map(o => [side(o), { price: o.price, point: o.point ?? null }]));
    }
  }
  return out;
}

// ---------------------------------------------------------------- ESPN (public, no key)
const espn = {
  async board(lg, ymd, ymd2) {   // ymd = YYYY-MM-DD (US Eastern date, which is how ESPN files games)
    const L = LEAGUES[lg], d = ymd.replace(/-/g, '') + (ymd2 ? '-' + ymd2.replace(/-/g, '') : '');
    const url = g => `https://site.api.espn.com/apis/site/v2/sports/${L.espn}/scoreboard?dates=${d}&limit=400${g ? '&groups=' + g : ''}`;
    let j = await (await get(url(L.groups), 'ESPN')).json();
    if (L.groups && !(j.events || []).length) j = await (await get(url(''), 'ESPN')).json();
    return (j.events || []).map(espnEvent).filter(Boolean);
  },
};
function espnEvent(e) {
  const c = e.competitions?.[0]; if (!c) return null;
  const team = hA => { const x = c.competitors.find(t => t.homeAway === hA) || {}; const t = x.team || {};
    return { names: [t.displayName, t.shortDisplayName, t.location && t.name ? t.location + ' ' + t.name : null, t.name, t.location, t.abbreviation], abbr: t.abbreviation || '', score: x.score != null && x.score !== '' ? +(x.score.value ?? x.score) : null }; };
  const st = c.status?.type || e.status?.type || {};
  const ev = { src: 'espn', id: String(e.id), commence: new Date(Date.parse(e.date)).toISOString(), home: team('home'), away: team('away'), state: st.state, completed: !!st.completed, status: st.name || '' };
  const o = (c.odds || []).find(x => String(x.provider?.id) === '100') || (c.odds || [])[0];
  if (o) {
    ev.odds_book = /draft/i.test(o.provider?.name || '') || String(o.provider?.id) === '100' ? 'draftkings' : bookKey(o.provider?.name || 'espn');
    const at = (obj, k) => obj?.[k] || null, mk = k => {   // k = 'open' | 'close'
      const b = {}, ml = o.moneyline, ps = o.pointSpread, tot = o.total;
      if (ml) { const hh = at(ml.home, k), aa = at(ml.away, k); if (hh?.odds && aa?.odds) b.h2h = { home: { price: american(hh.odds), point: null }, away: { price: american(aa.odds), point: null } }; }
      if (ps) { const hh = at(ps.home, k), aa = at(ps.away, k); if (hh?.line && aa?.line) b.spreads = { home: { price: american(hh.odds) || -110, point: num(hh.line) }, away: { price: american(aa.odds) || -110, point: num(aa.line) } }; }
      if (tot) { const ov = at(tot.over, k), un = at(tot.under, k); if (ov?.line && un?.line) b.totals = { over: { price: american(ov.odds) || -110, point: num(ov.line) }, under: { price: american(un.odds) || -110, point: num(un.line) } }; }
      for (const m of Object.values(b)) for (const s of Object.values(m)) if (!isFinite(s.price)) s.price = null;
      return Object.keys(b).length ? b : null;
    };
    ev.lines = { open: mk('open'), close: mk('close') };
  }
  return ev;
}

// ---------------------------------------------------------------- snapshots + CLV
// Our side and the other side of the pick's market at one book.
function sidesAt(p, b) {
  if (!b) return null;
  if (p.market.startsWith('player_')) {
    const pl = norm(p.player), last = pl.split(' ').pop();
    const rows = (b.props || []).filter(o => o.market === p.market && (norm(o.player) === pl || norm(o.player).endsWith(' ' + last)));
    const ours = rows.filter(o => o.side === p.side), other = rows.filter(o => o.side !== p.side);
    const pickOne = rs => rs.sort((x, y) => Math.abs((x.point ?? 0) - (p.line ?? 0)) - Math.abs((y.point ?? 0) - (p.line ?? 0)))[0];
    const us = pickOne(ours); if (!us) return null;
    const them = other.find(o => o.point === us.point) || null;
    return { us: { price: us.price, point: us.point }, them: them && { price: them.price, point: them.point } };
  }
  const m = b[p.market]; if (!m) return null;
  const k = p.event.side, o = { home: 'away', away: 'home', over: 'under', under: 'over' }[k];
  return m[k] && isFinite(m[k].price) ? { us: m[k], them: m[o] && isFinite(m[o].price) ? m[o] : null } : null;
}
// Keep only what CLV needs: our side + the other side at every book.
function snap(p, books, src) {
  const s = { at: new Date().toISOString(), src, books: {} };
  for (const [k, b] of Object.entries(books)) { const x = sidesAt(p, b); if (x) s.books[k] = [x.us.price, x.us.point, x.them?.price ?? null, x.them?.point ?? null]; }
  return Object.keys(s.books).length ? s : null;
}
const noVig = r => r && isFinite(r[2]) && r[2] != null ? imp(r[0]) / (imp(r[0]) + imp(r[2])) : null;
// Points our side gained vs the close (positive = we got the better number)
function pointsGained(p, closePt) {
  if (p.line == null || closePt == null) return 0;
  if (p.market === 'spreads') return +(p.line - closePt).toFixed(2);
  return +((p.side === 'under' ? p.line - closePt : closePt - p.line)).toFixed(2);   // over: lower is better
}
// Rough win-probability value of one point when our number differs from the closing number (key numbers ignored),
// so a pick that got a better line still gets a CLV % – marked est.
const PER_POINT = { nfl: { spreads: 0.03, totals: 0.02 }, ncaaf: { spreads: 0.025, totals: 0.015 }, nba: { spreads: 0.03, totals: 0.02 },
  ncaab: { spreads: 0.03, totals: 0.02 }, nhl: { totals: 0.12 }, mlb: { totals: 0.1 } };
function scoreClv(p) {
  const c = p.close; if (!c || !c.books) return null;
  const refBook = c.books[p.book] ? p.book : REF_ORDER.find(b => c.books[b]) || Object.keys(c.books)[0];
  const r = c.books[refBook]; if (!r) return null;
  const pts = pointsGained(p, r[1]);
  const out = { ref: refBook, close_price: r[0], close_point: r[1], points: pts || 0 };
  // no-vig closing probability: sharpest book with the same number, else the reference book
  const sharp = SHARP.map(b => [b, c.books[b]]).find(([, x]) => x && x[1] === r[1] && noVig(x) != null);
  const [fb, fr] = sharp || [refBook, r], fp = noVig(fr);
  if (!pts) {
    out.price_clv = +(dec(p.price) / dec(r[0]) - 1).toFixed(4);
    if (fp != null) { out.fair_book = fb; out.fair_prob = +fp.toFixed(4); out.ev = +(dec(p.price) * fp - 1).toFixed(4); }
    out.beat = dec(p.price) > dec(r[0]) + 1e-9;
  } else {
    out.beat = pts > 0;
    const per = PER_POINT[p.league]?.[p.market];
    if (fp != null && per) { const q = Math.min(0.97, Math.max(0.03, fp + pts * per)); out.fair_book = fb; out.fair_prob = +q.toFixed(4); out.ev = +(dec(p.price) * q - 1).toFixed(4); out.est = true; }
  }
  out.clv = out.ev ?? out.price_clv ?? null;
  return out;
}

// ---------------------------------------------------------------- grading (ESPN final scores)
function grade(p, ev) {
  if (!ev || !ev.completed || ev.home.score == null || ev.away.score == null) return null;
  if (!['h2h', 'spreads', 'totals'].includes(p.market)) return null;
  const hs = ev.home.score, as = ev.away.score, us = p.event.side;
  let margin;
  if (p.market === 'h2h') margin = us === 'home' ? hs - as : as - hs;
  else if (p.market === 'spreads') margin = (us === 'home' ? hs - as : as - hs) + p.line;
  else margin = p.side === 'over' ? hs + as - p.line : p.line - (hs + as);
  const result = margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
  return { result, score: `${ev.away.abbr || 'away'} ${as} @ ${ev.home.abbr || 'home'} ${hs}`, final: ev.status };
}
const profit = p => p.result === 'win' ? +(p.units * (dec(p.price) - 1)).toFixed(3) : p.result === 'loss' ? -p.units : 0;

// ---------------------------------------------------------------- stats + report
function stats(picks) {
  const s = { n: picks.length, scored: 0, beat: 0, clvSum: 0, clvN: 0, w: 0, l: 0, p: 0, units: 0, risked: 0 };
  for (const p of picks) {
    if (p.clv) { s.scored++; if (p.clv.beat) s.beat++; if (p.clv.clv != null) { s.clvSum += p.clv.clv; s.clvN++; } }
    if (['win', 'loss', 'push'].includes(p.result)) { s[p.result[0]]++; s.units += profit(p); if (p.result !== 'push') s.risked += p.units; }
  }
  s.avgClv = s.clvN ? s.clvSum / s.clvN : null; s.beatRate = s.scored ? s.beat / s.scored : null; s.units = +s.units.toFixed(2); s.roi = s.risked ? s.units / s.risked : null;
  return s;
}
const statLine = s => `${s.n} pick${s.n === 1 ? '' : 's'} · beat the close ${s.scored ? `${s.beat}/${s.scored} (${Math.round(s.beatRate * 100)}%)` : '–'} · avg CLV ${pct(s.avgClv)} · ${s.w}-${s.l}${s.p ? '-' + s.p : ''} · ${s.units >= 0 ? '+' : ''}${s.units}u`;
const pickLabel = p => p.market === 'h2h' ? `${p.side} ML` : p.market === 'spreads' ? `${p.side} ${p.line > 0 ? '+' : ''}${p.line}` : p.market === 'totals' ? `${p.side === 'over' ? 'Over' : 'Under'} ${p.line}` : `${p.player} ${p.side} ${p.line ?? ''} ${p.market.replace(/^player_/, '').replace(/_/g, ' ')}`.trim();

// ---------------------------------------------------------------- DMs (through notify.yml, channel=dm – never a shared channel)
function dm(h, key, text) {
  if (key && h.alerted[key]) return false;
  if (key) h.alerted[key] = new Date().toISOString();
  h._dirty = true;
  note(h, 'DM: ' + text.split('\n')[0]);
  if (DRY || !process.env.GH_TOKEN || !process.env.GITHUB_REPOSITORY) { console.log('[dry] would DM:\n' + text); return true; }
  for (let i = 0; i < 3; i++) {
    try { execFileSync('gh', ['workflow', 'run', 'notify.yml', '-R', process.env.GITHUB_REPOSITORY, '--ref', 'main', '-f', 'channel=dm', '-f', 'text=' + text.slice(0, 1900)], { stdio: 'inherit' }); return true; }
    catch (e) { console.log('notify dispatch failed, try ' + (i + 1)); execFileSync('sleep', [String(10 * (i + 1))]); }
  }
  if (key) delete h.alerted[key];   // try again next cycle
  process.exitCode = 1;             // a red run at least shows up in GitHub
  return false;
}

module.exports = { TZ, DATA, PICKS, HEALTH, HEALTH_REC, KEY, DRY, OPEN_RESERVE, LOW_CREDITS, LEAGUES, leagueOf, bookKey, american, dec, imp, fmtA, num, pct, norm, slug,
  localDate, localHM, addDays, when, uniq, groupBy, sleep, readJSON, writeJSON, loadPicks, savePick, pickFile, loadHealth, saveHealth, note, parsePick,
  aliases, teamScore, eventScore, bestEvent, sideKey, get, oddsapi, booksFromOddsApi, espn, espnEvent, sidesAt, snap, scoreClv, pointsGained, grade, profit,
  stats, statLine, pickLabel, dm };
