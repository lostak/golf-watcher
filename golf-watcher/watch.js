// Golf tee-time watcher. Reads public tee sheets in a headless browser (never signs in, never books)
// and posts to Slack when a new tee time fits a window in wants.json.
const { chromium } = require('playwright');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('wants.json', 'utf8'));
const STATE = 'state/seen.json';
const DRY = process.argv.includes('--dry');
const TZ = cfg.timezone || 'America/Denver';

const MS_SITES = [ // MemberSports: page + the club/course ids its own booking call uses
  { page: 'https://app.membersports.com/tee-times/3629/20573/1/1/0', label: 'Denver Golf' },
  { page: 'https://app.membersports.com/tee-times/3697/4758/0/3/0', label: 'Foothills' },
];
const GOLFNOW = [{ id: 17877, slug: 'saddle-rock-golf-course', label: 'Saddle Rock' }];

const todayDenver = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmt = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`; };
const niceDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

// NOAA sunrise/sunset for Denver, returns minutes after local midnight (MST/MDT per date)
function sun(dateStr) {
  const lat = 39.74, lon = -104.99, [y, mo, d] = dateStr.split('-').map(Number);
  const N = Math.floor(275 * mo / 9) - 2 * Math.floor((mo + 9) / 12) + d - 30;
  const rad = Math.PI / 180, out = {};
  for (const [k, rising] of [['rise', true], ['set', false]]) {
    const lng = lon / 15, t = N + ((rising ? 6 : 18) - lng) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634; L = (L % 360 + 360) % 360;
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad; RA = (RA % 360 + 360) % 360;
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    let H = Math.acos(cosH) / rad; if (rising) H = 360 - H; H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    const utc = ((T - lng) % 24 + 24) % 24;
    // offset from the real zone rules
    const probe = new Date(Date.UTC(y, mo - 1, d, 12));
    const off = (new Date(probe.toLocaleString('en-US', { timeZone: TZ })) - new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))) / 3600000;
    out[k] = Math.round((((utc + off) % 24) + 24) % 24 * 60);
  }
  return out;
}

function windowsFor(date) {
  const { rise, set } = sun(date);
  return cfg.wants.filter(w => w.date === date).map(w => ({
    from: Math.max(hm(w.from), rise), to: Math.min(hm(w.to), set - 120), players: w.players }));
}

async function readMemberSports(browser, site, dates) {
  const found = [], p = await browser.newPage();
  let req; p.on('request', r => { if (/onlineBookingTeeTimes/.test(r.url())) req = r; });
  await p.goto(site.page, { waitUntil: 'networkidle', timeout: 60000 });
  for (let i = 0; i < 10 && !req; i++) await p.waitForTimeout(1000);
  if (!req) throw new Error('no booking request seen for ' + site.page);
  const h = req.headers(); delete h['content-length'];
  const base = JSON.parse(req.postData());
  for (const date of dates) {
    const text = await p.evaluate(async ({ h, body }) => (await fetch('https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes',
      { method: 'POST', headers: h, body: JSON.stringify(body) })).text(), { h, body: { ...base, date } });
    for (const slot of JSON.parse(text)) for (const it of slot.items || []) {
      if (it.bookingNotAllowed || it.hide) continue;
      if (cfg.courses && !new RegExp(cfg.courses, 'i').test(it.name)) continue;
      const spots = 4 - it.playerCount;
      found.push({ date, min: slot.teeTime, course: it.name, spots, price: it.price, link: site.page, key: `${date}|${it.name}|${slot.teeTime}` });
    }
  }
  await p.close(); return found;
}

async function readGolfNow(browser, c, dates, maxPlayers) {
  const found = [], p = await browser.newPage();
  let last;
  p.on('response', async r => { if (/tee-time-search-results/.test(r.url())) { try { last = JSON.parse(await r.text()); } catch (e) {} } });
  for (const date of dates) {
    last = null;
    const d = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).replace(/,? /g, '+').replace(',', '');
    const link = `https://www.golfnow.com/tee-times/facility/${c.id}-${c.slug}/search#date=${d}&players=${maxPlayers}`;
    await p.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 15 && !last; i++) await p.waitForTimeout(1000);
    if (!last) continue;
    for (const t of last.ttResults.teeTimes) {
      const [hh, mm] = t.time.formatted.split(':').map(Number);
      const min = (t.time.formattedTimeMeridian === 'PM' && hh !== 12 ? hh + 12 : hh % 12 === 0 && t.time.formattedTimeMeridian === 'AM' ? 0 : hh) * 60 + mm;
      const price = t.minTeeTimeRate && t.minTeeTimeRate.value;
      found.push({ date, min, course: c.label, spots: maxPlayers, price, link, key: `${date}|${c.label}|${min}` });
    }
  }
  await p.close(); return found;
}

(async () => {
  const today = todayDenver();
  const wants = cfg.wants.filter(w => w.date >= today);
  if (!wants.length) { console.log('No upcoming wants.'); return; }
  const dates = [...new Set(wants.map(w => w.date))];
  const seen = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  for (const k of Object.keys(seen)) if (k.slice(0, 10) < today) delete seen[k];
  const browser = await chromium.launch();
  let all = [];
  const errors = [];
  for (const s of MS_SITES) { try { all = all.concat(await readMemberSports(browser, s, dates)); } catch (e) { errors.push(`${s.label}: ${e.message.slice(0, 80)}`); } }
  for (const c of GOLFNOW) {
    try { for (const date of dates) all = all.concat(await readGolfNow(browser, c, [date], Math.max(...wants.filter(w => w.date === date).map(w => w.players)))); }
    catch (e) { errors.push(`${c.label}: ${e.message.slice(0, 80)}`); }
  }
  await browser.close();
  const matches = [];
  for (const f of all) {
    if (seen[f.key]) continue;
    const ok = windowsFor(f.date).some(w => f.min >= w.from && f.min <= w.to && f.spots >= w.players);
    if (ok) matches.push(f);
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.min - b.min);
  console.log(`read ${all.length} tee times; ${matches.length} new match(es); errors: ${errors.join('; ') || 'none'}`);
  for (const m of matches) console.log(`  ${m.date} ${fmt(m.min)} ${m.course} ${m.spots} spots $${m.price}`);

  if (matches.length && !DRY) {
    const top = matches[0];
    let msg = `🚨 *TEE TIME OPEN – BOOK NOW*\n*${niceDate(top.date)} ${fmt(top.min)} – ${top.course} – ${top.spots} spots*\n${top.link}`;
    for (const m of matches.slice(1, 8)) msg += `\n${niceDate(m.date)} ${fmt(m.min)} – ${m.course} – ${m.spots} spots${m.price ? ' – $' + m.price : ''} – book: ${m.link}`;
    msg += `\nBook directly on the course's site. Pick the date on the page.`;
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) throw new Error('SLACK_WEBHOOK_URL not set');
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg }) });
    if (!r.ok) throw new Error('Slack post failed ' + r.status);
    for (const m of matches) seen[m.key] = Date.now();
  }
  if (errors.length && process.env.SLACK_WEBHOOK_URL && !DRY && !all.length) {
    await fetch(process.env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '⚠️ Golf watcher could not read any tee sheets: ' + errors.join('; ') }) });
  }
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(seen, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
