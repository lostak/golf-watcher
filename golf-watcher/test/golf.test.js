// Golf watcher tests (node --test). Real cases from Nov 19, 2026: "watch stop all" not understood, "watch stop thursday" created a watch,
// alerts listed tee times that had already passed, the same Kennedy time twice, and 9-hole-only times.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(dir, 'watch.js'), 'utf8');
const W = new Function('TZ', src.slice(src.indexOf('const nowMinDenver'), src.indexOf('const todayDenver')) + '; return { normCourse, dedupeTimes, alertText };')('America/Denver');
const fmt = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`; };
const nice = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const L = 'https://app.membersports.com/tee-times/3629/20573/1/1/0';
const row = (course, min, spots, price, date = '2026-11-19') => ({ date, course, min, spots, price, link: L });

test('past tee times are dropped (today needs 20 min lead); same start under two Kennedy names is one row with the most spots', () => {
  const out = W.dedupeTimes([row('Kennedy (Babe Lind / West)', 620, 4, 57), row('Kennedy (West / Babe Lind)', 870, 2, 25), row('Kennedy (Babe Lind / West)', 870, 4, 25), row('Wellshire', 812, 4, 28)], '2026-11-19', 13 * 60 + 19);
  assert.deepStrictEqual(out.map(f => `${f.course}|${f.min}|${f.spots}`), ['Kennedy (Babe Lind / West)|870|4']);
});

test('alert: one line per course per day, short, with a stop hint', () => {
  const m = [row('Wellshire', 850, 4, 28), row('Kennedy (Babe Lind / West)', 870, 4, 25), row('Kennedy (Babe Lind / West)', 880, 4, 51), row('City Park', 540, 4, 58, '2026-11-21')];
  const t = W.alertText(m, nice, fmt);
  assert.match(t, /• Kennedy \(Babe Lind \/ West\): 2:30 PM, 2:40 PM · \$25–51 · \[book\]/);
  assert.strictEqual((t.match(/^• /gm) || []).length, 3);
  assert.match(t, /Say "stop all" or "stop Thu"/);
});

test('9-hole-only times are excluded', () => {
  const ex = new RegExp(JSON.parse(fs.readFileSync(path.join(dir, 'wants.json'), 'utf8')).exclude, 'i');
  assert.ok(ex.test('Kennedy (Creek 9 only)')); assert.ok(!ex.test('Kennedy (Babe Lind / West)'));
});

test('Discord commands: "watch stop …" stops, never creates a watch', () => {
  const orig = fs.readFileSync(path.join(dir, 'wants.json'), 'utf8');
  const run = (text) => {
    const c = JSON.parse(orig); c.wants = [{ date: '2099-11-21', from: '09:00', to: '10:00', players: 4, courses: ['Kennedy'] }, { date: '2099-11-19', from: '05:00', to: '21:00', players: 2 }];
    fs.writeFileSync(path.join(dir, 'wants.json'), JSON.stringify(c));
    const { spawnSync } = require('child_process');   // exit 3 = "changed" (the workflow commits), not an error
    const r = spawnSync('node', ['commands.js', '--text', text], { cwd: dir, env: { ...process.env, GCAL_SA_KEY: '' } });
    assert.ok([0, 3].includes(r.status), String(r.stderr)); const out = String(r.stdout);
    return { out, wants: JSON.parse(fs.readFileSync(path.join(dir, 'wants.json'), 'utf8')).wants };
  };
  try {
    assert.strictEqual(run('watch stop all').wants.length, 0);
    assert.strictEqual(run('stop').wants.length, 0);
    assert.strictEqual(run('please cancel everything').wants.length, 0);
    assert.deepStrictEqual(run('watch stop Kennedy').wants.map(w => w.date), ['2099-11-19']);
    const r = run('stop watching Thursday please'); assert.ok(!/Got it – watching/.test(r.out), 'never creates a watch');
  } finally { fs.writeFileSync(path.join(dir, 'wants.json'), orig); }
});
