// Offline end-to-end test: node clv/test/run.js  (no network, no git, no Discord – DMs are printed)
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert'), { execFileSync } = require('child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clv-test-')), MOCK = path.join(dir, 'mock.json');
process.env.CLV_DATA = path.join(dir, 'data'); process.env.CLV_REPORT = path.join(dir, 'REPORT.md');
const L = require('../lib');
const root = path.join(__dirname, '..');
const iso = ms => new Date(ms).toISOString();
let failures = 0;
const check = (name, fn) => { try { fn(); console.log('✓ ' + name); } catch (e) { failures++; console.log('✗ ' + name + '\n   ' + e.message); } };

// ---- unit: parsing
check('parse spread from side text', () => { const { pick, errs } = L.parsePick({ league: 'NFL', game: 'Broncos @ Chiefs', side: 'Broncos +3.5', price: '-110', book: 'DraftKings' }); assert.deepStrictEqual(errs, []); assert.strictEqual(pick.market, 'spreads'); assert.strictEqual(pick.line, 3.5); assert.strictEqual(pick.side, 'Broncos'); });
check('parse total o44.5', () => { const { pick, errs } = L.parsePick({ game: 'Broncos @ Chiefs', market: 'total', side: 'o44.5', price: -105 }); assert.deepStrictEqual(errs, []); assert.strictEqual(pick.side, 'over'); assert.strictEqual(pick.line, 44.5); });
check('parse ML with price in side', () => { const { pick, errs } = L.parsePick({ game: 'Rangers vs Canadiens', side: 'Rangers -150' }); assert.deepStrictEqual(errs, []); assert.strictEqual(pick.market, 'h2h'); assert.strictEqual(pick.price, -150); });
check('parse prop', () => { const { pick, errs } = L.parsePick({ game: 'Broncos @ Chiefs', market: 'prop', player: 'Patrick Mahomes', stat: 'passing yards', side: 'over', line: 249.5, price: -115, book: 'FanDuel' }); assert.deepStrictEqual(errs, []); assert.strictEqual(pick.market, 'player_pass_yds'); assert.strictEqual(pick.book, 'fanduel'); });
check('decimal price', () => assert.strictEqual(L.american('2.50'), 150));
check('bad pick is rejected', () => { const { errs } = L.parsePick({ game: 'X', market: 'spread', side: 'X' }); assert.ok(errs.length >= 2); });
check('team matching prefers Ohio State over Ohio', () => {
  const evs = [{ commence: iso(Date.now() + 3600e3), home: { names: ['Ohio Bobcats'] }, away: { names: ['Kent State Golden Flashes'] } },
    { commence: iso(Date.now() + 3600e3), home: { names: ['Michigan Wolverines'] }, away: { names: ['Ohio State Buckeyes'] } }];
  const { pick } = L.parsePick({ game: 'Ohio State @ Michigan', side: 'Ohio State', market: 'ml', price: -200 });
  assert.strictEqual(L.bestEvent(pick, evs).home.names[0], 'Michigan Wolverines');
});
check('CLV math: -110 vs close -125, Pinnacle no-vig', () => {
  const p = { market: 'spreads', side: 'Broncos', line: 3.5, price: -110, book: 'draftkings', close: { books: { draftkings: [-125, 3.5, 105, -3.5], pinnacle: [-121, 3.5, 110, -3.5] } } };
  const c = L.scoreClv(p); assert.ok(c.beat); assert.strictEqual(c.fair_book, 'pinnacle'); assert.ok(c.ev > 0.015 && c.ev < 0.03, String(c.ev));   // 1.909 × 0.5348 − 1
});
check('CLV points: got +3.5, closed +2.5', () => { const c = L.scoreClv({ league: 'nfl', market: 'spreads', line: 3.5, price: -110, book: 'draftkings', close: { books: { draftkings: [-110, 2.5, -110, -2.5] } } }); assert.strictEqual(c.points, 1); assert.ok(c.beat); assert.ok(c.est && Math.abs(c.ev - (1.9091 * 0.53 - 1)) < 0.002, String(c.ev)); });
check('CLV points: over 44.5 closed 43.5 is a loss of a point', () => { const c = L.scoreClv({ market: 'totals', side: 'over', line: 44.5, price: -110, book: 'draftkings', close: { books: { draftkings: [-110, 43.5, -110, 43.5] } } }); assert.strictEqual(c.points, -1); assert.ok(!c.beat); });

// ---- end to end with mocked sources
const T0 = Date.now(), KC = 'e-nfl-1', NYR = 'e-nhl-1';
const ev = (id, home, away, t) => ({ id, sport_key: 'x', commence_time: iso(t), home_team: home, away_team: away });
const bk = (key, home, away, ml, sp, tot) => ({ key, markets: [
  { key: 'h2h', outcomes: [{ name: home, price: ml[0] }, { name: away, price: ml[1] }] },
  { key: 'spreads', outcomes: [{ name: home, price: sp[1], point: -sp[0] }, { name: away, price: sp[2], point: sp[0] }] },
  { key: 'totals', outcomes: [{ name: 'Over', price: tot[1], point: tot[0] }, { name: 'Under', price: tot[2], point: tot[0] }] }] });
const espnGame = (id, t, home, away, hs, as, done, close) => ({ id, date: iso(t).slice(0, 16) + 'Z', competitions: [{ status: { type: { name: done ? 'STATUS_FINAL' : 'STATUS_SCHEDULED', state: done ? 'post' : 'pre', completed: done } },
  competitors: [{ homeAway: 'home', score: String(hs), team: { displayName: home[0], shortDisplayName: home[1], abbreviation: home[2], location: home[0].split(' ')[0], name: home[1] } },
    { homeAway: 'away', score: String(as), team: { displayName: away[0], shortDisplayName: away[1], abbreviation: away[2], location: away[0].split(' ')[0], name: away[1] } }],
  odds: [{ provider: { id: '100', name: 'Draft Kings' }, moneyline: { home: { close: { odds: close.ml[0] }, open: { odds: '-120' } }, away: { close: { odds: close.ml[1] }, open: { odds: '+100' } } },
    pointSpread: { home: { close: { line: String(-close.sp), odds: '-110' } }, away: { close: { line: '+' + close.sp, odds: '-110' } } },
    total: { over: { close: { line: 'o' + close.tot, odds: '-110' } }, under: { close: { line: 'u' + close.tot, odds: '-110' } } } }] }] });
const KCn = ['Kansas City Chiefs', 'Chiefs', 'KC'], DENn = ['Denver Broncos', 'Broncos', 'DEN'], NYRn = ['New York Rangers', 'Rangers', 'NYR'], MTLn = ['Montreal Canadiens', 'Canadiens', 'MTL'];
let fx = {
  events: { americanfootball_nfl: [ev(KC, KCn[0], DENn[0], T0 + 5 * 3600e3)], icehockey_nhl: [ev(NYR, NYRn[0], MTLn[0], T0 + 6 * 3600e3)] },
  odds: { americanfootball_nfl: [{ ...ev(KC, KCn[0], DENn[0], T0 + 5 * 3600e3), bookmakers: [bk('draftkings', KCn[0], DENn[0], [-180, 150], [3.5, -110, -110], [44.5, -110, -110]), bk('pinnacle', KCn[0], DENn[0], [-175, 160], [3.5, -105, -105], [44.5, -105, -105])] }],
    icehockey_nhl: [{ ...ev(NYR, NYRn[0], MTLn[0], T0 + 6 * 3600e3), bookmakers: [bk('draftkings', NYRn[0], MTLn[0], [-150, 125], [1.5, 160, -190], [6.5, -110, -110])] }] },
  espn: { 'football/nfl': [espnGame('401', T0 + 5 * 3600e3, KCn, DENn, 0, 0, false, { ml: ['-180', '+150'], sp: 3.5, tot: 44.5 })], 'hockey/nhl': [espnGame('402', T0 + 6 * 3600e3, NYRn, MTLn, 0, 0, false, { ml: ['-150', '+125'], sp: 1.5, tot: 6.5 })] },
};
const save = () => fs.writeFileSync(MOCK, JSON.stringify(fx));
const run = (script, env = {}) => { save(); try { return execFileSync('node', ['-r', path.join(__dirname, 'mock.js'), path.join(root, script)], { env: { ...process.env, CLV_MOCK: MOCK, ODDS_API_KEY: 'test', GH_TOKEN: '', ...env }, encoding: 'utf8' }); } catch (e) { return 'EXIT ' + e.status + '\n' + e.stdout + e.stderr; } };
const picks = () => L.loadPicks();

const in1 = JSON.stringify([
  { league: 'nfl', game: 'Broncos @ Chiefs', market: 'spread', side: 'Broncos', line: 3.5, price: -110, book: 'DraftKings', units: 1, why: 'test' },
  { game: 'Broncos at Chiefs', market: 'total', side: 'Over', line: 44.5, price: -105, book: 'bet365', units: 0.5 },
  { league: 'nhl', game: 'Canadiens @ Rangers', market: 'moneyline', side: 'Rangers', price: -140, book: 'FanDuel' },
]);
let out = run('record.js', { PICKS: in1, SOURCE: 'duet' });
check('record: 3 picks recorded and matched, open snapshot taken', () => { assert.ok(!/PROBLEM/.test(out), out); const ps = picks(); assert.strictEqual(ps.length, 3); assert.ok(ps.every(p => p.event && p.open), JSON.stringify(ps.map(p => [p.id, p.match_error, !!p.open]))); });
check('record: bet365 total matched to the NFL game without a league', () => assert.strictEqual(picks().find(p => p.book === 'bet365').league, 'nfl'));
out = run('record.js', { PICKS: in1, SOURCE: 'duet' });
check('record: same picks again are not duplicated', () => { assert.strictEqual(picks().length, 3); assert.ok(/already recorded/.test(out)); });
out = run('record.js', { PICKS: '[{"game":"Nobody @ Nowhere","market":"spread","side":"Nobody"}]', SOURCE: 'life' });
check('record: bad pick → exit 2 and a DM', () => { assert.ok(/EXIT 2/.test(out) && /would DM/.test(out), out); });
out = run('record.js', { PICKS: '[{"league":"nfl","game":"Broncos @ Chiefs","market":"ml","side":"Broncos","price":150,"book":"FanDuel"}]', SOURCE: 'life' });
check('record: a Life pick lands as source life', () => assert.ok(picks().some(p => p.source === 'life')));

// move the NFL game to 5 minutes from now with a new line: the close is due
const nflClose = T0 + 5 * 60e3;
fx.events.americanfootball_nfl = [ev(KC, KCn[0], DENn[0], nflClose)];
fx.odds.americanfootball_nfl[0] = { ...ev(KC, KCn[0], DENn[0], nflClose), bookmakers: [bk('draftkings', KCn[0], DENn[0], [-190, 158], [2.5, -110, -110], [46.5, -110, -110]), bk('pinnacle', KCn[0], DENn[0], [-185, 165], [2.5, -104, -106], [46.5, -103, -107])] };
for (const p of picks()) if (p.league === 'nfl') { p.event.commence = iso(nflClose + 60e3); L.savePick(p); }   // refreshStart should correct this
fs.writeFileSync(MOCK + '.log', '');
out = run('watch.js');
check('watch: NFL closes taken from The Odds API, NHL not yet', () => { const ps = picks(); assert.ok(ps.filter(p => p.league === 'nfl').every(p => p.close?.src === 'oddsapi'), out); assert.ok(ps.filter(p => p.league === 'nhl').every(p => !p.close)); });
check('watch: start time refreshed', () => assert.strictEqual(picks().find(p => p.league === 'nfl').event.commence, iso(nflClose)));
check('watch: Broncos +3.5 vs close +2.5 = +1 point, beat', () => { const p = picks().find(p => p.market === 'spreads'); assert.strictEqual(p.clv.points, 1); assert.ok(p.clv.beat); });
check('watch: over 44.5 vs close 46.5 = +2 points', () => assert.strictEqual(picks().find(p => p.market === 'totals').clv.points, 2));
check('watch: Life Broncos ML +150 vs close +158 = negative CLV, not beat', () => { const p = picks().find(p => p.source === 'life'); assert.ok(!p.clv.beat && p.clv.clv < 0, JSON.stringify(p.clv)); });
check('watch: one odds call for the NFL closes (2 markets × 1 region)', () => { const log = fs.readFileSync(MOCK + '.log', 'utf8').split('\n').filter(l => /\/odds\?/.test(l)); assert.strictEqual(log.length, 1, log.join('\n')); assert.ok(/markets=(spreads,totals,h2h|[a-z2,]+)/.test(log[0])); });
check('report written', () => assert.ok(/Beat the close/.test(fs.readFileSync(process.env.CLV_REPORT, 'utf8'))));

// Odds API down when the NHL close is due → ESPN DraftKings fallback
const nhlT = T0 + 4 * 60e3;
fx.oddsDown = true;
L.writeJSON(L.HEALTH, { fails: { oddsapi: 1 } });   // one earlier failure
fx.espn['hockey/nhl'] = [espnGame('402', nhlT, NYRn, MTLn, 0, 0, false, { ml: ['-160', '+135'], sp: 1.5, tot: 6.5 })];
for (const p of picks()) if (p.league === 'nhl') { p.event.commence = iso(nhlT); L.savePick(p); }
out = run('watch.js');
check('watch: Odds API down → ESPN close used', () => { const p = picks().find(p => p.league === 'nhl'); assert.strictEqual(p.close?.src, 'espn', out); assert.strictEqual(p.clv.ref, 'draftkings'); assert.ok(p.clv.beat); });
check('watch: third Odds API failure → one DM', () => assert.ok(/would DM/.test(out) && /Odds API keeps failing/.test(out), out));
out = run('watch.js');
check('watch: no repeat DM', () => assert.ok(!/keeps failing/.test(out)));
fx.oddsDown = false;

// games over → graded from ESPN
fx.espn['football/nfl'] = [espnGame('401', T0 - 5 * 3600e3, KCn, DENn, 24, 23, true, { ml: ['-190', '+158'], sp: 2.5, tot: 46.5 })];
fx.espn['hockey/nhl'] = [espnGame('402', T0 - 4 * 3600e3, NYRn, MTLn, 2, 4, true, { ml: ['-160', '+135'], sp: 1.5, tot: 6.5 })];
for (const p of picks()) { p.event.commence = iso(p.league === 'nfl' ? T0 - 5 * 3600e3 : T0 - 4 * 3600e3); L.savePick(p); }
out = run('watch.js');
check('watch: grading', () => {
  const ps = picks(), r = m => ps.find(m).result;
  assert.strictEqual(r(p => p.market === 'spreads'), 'win', out);   // DEN +3.5, lost by 1
  assert.strictEqual(r(p => p.market === 'totals'), 'win');          // 47 > 44.5
  assert.strictEqual(r(p => p.source === 'life'), 'loss');           // DEN ML
  assert.strictEqual(r(p => p.league === 'nhl'), 'loss');            // NYR lost
});
check('stats line', () => { const s = L.stats(picks().filter(p => p.source === 'duet')); assert.strictEqual(s.w, 2); assert.strictEqual(s.l, 1); console.log('   ' + L.statLine(s)); });
check('nothing left to wake for', () => { const { nextWake } = require('../watch'); assert.strictEqual(nextWake(picks(), Date.now()), Infinity); });

// missed close: game started an hour ago, no close, ESPN gives no lines
fx.espn['hockey/nhl'] = [];
const { pick: miss } = L.parsePick({ league: 'nhl', game: 'Canadiens @ Rangers', side: 'Canadiens', market: 'ml', price: 130, date: '2026-01-01' }, 'duet');
Object.assign(miss, { posted_at: iso(T0), status: 'open', result: 'pending', event: { commence: iso(T0 - 3600e3), home: NYRn[0], away: MTLn[0], side: 'away', espn_id: '999' } }); L.savePick(miss);
out = run('watch.js');
check('watch: missed close → DM', () => assert.ok(/missed the closing price/.test(out), out));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
