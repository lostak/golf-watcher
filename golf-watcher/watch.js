// Golf tee-time watcher. Reads public tee sheets in a headless browser (never signs in, never books)
// and posts to Slack when a new tee time fits a window in wants.json.
//
// Sources:
//   - GolfNow area search: every course GolfNow lists within `radiusMiles` of `center` (most Denver-metro
//     public courses: Aurora, Arvada, Westminster, Thornton, Brighton, Commerce City, Lakewood, Littleton, ...).
//   - MemberSports: Denver Golf (City Park, Wellshire, Kennedy, Overland Park, Willis Case, Harvard Gulch,
//     Evergreen) and Foothills, which aren't on GolfNow.
const { chromium } = require('playwright');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('wants.json', 'utf8'));
const STATE = 'state/seen.json';
const DRY = process.argv.includes('--dry');
const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === '1';
const TZ = cfg.timezone || 'America/Denver';
const CENTER = cfg.center || { lat: 39.7294, lng: -104.8319 }; // Aurora, CO
const RADIUS = cfg.radiusMiles || 30;
const INCLUDE = cfg.courses ? new RegExp(cfg.courses, 'i') : null;   // optional: only these courses
const EXCLUDE = cfg.exclude ? new RegExp(cfg.exclude, 'i') : null;   // optional: never these courses
const MAX_LINES = 12;

const MS_SITES = [ // MemberSports: page + the club/course ids its own booking call uses
  { page: 'https://app.membersports.com/tee-times/3629/20573/1/1/0', label: 'Denver Golf' },
  { page: 'https://app.membersports.com/tee-times/3697/4758/0/3/0', label: 'Foothills' },
];

const todayDenver = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const hm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const fmt = m => { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'AM' : 'PM'}`; };
const niceDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const gnDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).replace(',', '').replace(/ /g, '+');
const log = (...a) => console.log(...a);
const dbg = (...a) => { if (DEBUG) console.log('  [debug]', ...a); };
const wanted = name => (!INCLUDE || INCLUDE.test(name)) && !(EXCLUDE && EXCLUDE.test(name));

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

// ---------- MemberSports (Denver Golf, Foothills) ----------
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
    const slots = JSON.parse(text);
    dbg(`${site.label} ${date}: ${slots.length} slots`);
    for (const slot of slots) for (const it of slot.items || []) {
      if (it.bookingNotAllowed || it.hide) continue;
      if (!wanted(it.name)) continue;
      const spots = 4 - it.playerCount;
      found.push({ date, min: slot.teeTime, course: it.name, spots, price: it.price, link: site.page, key: `${date}|${it.name}|${slot.teeTime}` });
    }
  }
  await p.close(); return found;
}

// ---------- GolfNow area search (every course within the radius) ----------
function gnMinutes(t) {
  const iso = t.time && (t.time.time || t.time.iso || (typeof t.time === 'string' ? t.time : null));
  if (iso && /T\d\d:\d\d/.test(iso)) { const [, hh, mm] = iso.match(/T(\d\d):(\d\d)/); return +hh * 60 + +mm; }
  const f = t.time && (t.time.formatted || t.time.formattedTime), mer = t.time && t.time.formattedTimeMeridian;
  if (!f) return null;
  const [hh, mm] = f.split(':').map(Number);
  return ((mer === 'PM' && hh !== 12) ? hh + 12 : (mer === 'AM' && hh === 12) ? 0 : hh) * 60 + mm;
}
async function readGolfNow(browser, dates, playersByDate) {
  const found = [], p = await browser.newPage();
  const seenUrls = new Set();
  let req; // the site's own search call, replayed per date with a big page size
  p.on('request', r => { if (/tee-time-results|tee-time-search-results|tee-times\/search/i.test(r.url()) && r.method() === 'POST') req = r; });
  p.on('response', r => { if (DEBUG && /golfnow\.com\/api/i.test(r.url())) seenUrls.add(r.url()); });
  const first = dates[0], np = playersByDate[first];
  const url = `https://www.golfnow.com/tee-times/search#facilitytype=GolfCourse&date=${gnDate(first)}&longitude=${CENTER.lng}&latitude=${CENTER.lat}&radius=${RADIUS}&players=${np}&sortby=Facilities.Distance.0`;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 25 && !req; i++) await p.waitForTimeout(1000);
  if (!req) { dbg('api urls seen:', [...seenUrls].slice(0, 10)); throw new Error('no search request seen on the GolfNow area search page'); }
  const h = req.headers(); delete h['content-length'];
  const base = JSON.parse(req.postData() || '{}');
  dbg('GolfNow search body keys:', Object.keys(base).join(','), 'endpoint:', req.url());
  const facilities = new Set();
  for (const date of dates) {
    const body = { ...base, Date: gnDate(date).replace(/\+/g, ' '), PageSize: 500, PageNumber: 0, Radius: RADIUS, Latitude: CENTER.lat, Longitude: CENTER.lng, Players: String(playersByDate[date]) };
    if ('date' in base) body.date = body.Date;
    const text = await p.evaluate(async ({ u, h, body }) => (await fetch(u, { method: 'POST', headers: h, body: JSON.stringify(body) })).text(), { u: req.url(), h, body });
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('GolfNow search returned non-JSON: ' + text.slice(0, 80)); }
    const list = (j.ttResults && j.ttResults.teeTimes) || j.teeTimes || [];
    dbg(`GolfNow ${date}: ${list.length} tee times, total reported ${j.ttResults && j.ttResults.totalCount}`);
    for (const t of list) {
      const fac = t.facility || {};
      const name = fac.name || t.facilityName; if (!name || !wanted(name)) continue;
      facilities.add(name);
      const min = gnMinutes(t); if (min == null) continue;
      const price = (t.displayRate && (t.displayRate.value || t.displayRate)) || (t.minTeeTimeRate && t.minTeeTimeRate.value) || t.displayRate;
      const slug = fac.seoFriendlyName || fac.id || t.facilityId;
      const link = `https://www.golfnow.com/tee-times/facility/${slug}/search#date=${gnDate(date)}&players=${playersByDate[date]}`;
      found.push({ date, min, course: name, spots: playersByDate[date], price: typeof price === 'number' ? price : undefined, link, key: `${date}|${name}|${min}` });
    }
  }
  log(`GolfNow: ${facilities.size} courses within ${RADIUS} mi: ${[...facilities].sort().join(', ') || '(none)'}`);
  await p.close(); return found;
}

async function launch() {
  try { return await chromium.launch({ channel: 'chrome' }); }   // GitHub runners ship Google Chrome: no download needed
  catch (e) { dbg('system Chrome not available (' + e.message.split('\n')[0] + '), using Playwright Chromium'); return chromium.launch(); }
}

(async () => {
  const today = todayDenver();
  const wants = cfg.wants.filter(w => w.date >= today);
  if (!wants.length) { log('No upcoming wants.'); return; }
  const dates = [...new Set(wants.map(w => w.date))].sort();
  const playersByDate = Object.fromEntries(dates.map(d => [d, Math.max(...wants.filter(w => w.date === d).map(w => w.players))]));
  const seen = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  for (const k of Object.keys(seen)) if (k.slice(0, 10) < today) delete seen[k];
  const browser = await launch();
  let all = [];
  const errors = [];
  try { all = all.concat(await readGolfNow(browser, dates, playersByDate)); } catch (e) { errors.push(`GolfNow: ${e.message.slice(0, 100)}`); }
  for (const s of MS_SITES) { try { all = all.concat(await readMemberSports(browser, s, dates)); } catch (e) { errors.push(`${s.label}: ${e.message.slice(0, 100)}`); } }
  await browser.close();

  const matches = [];
  for (const f of all) {
    if (seen[f.key]) continue;
    const ok = windowsFor(f.date).some(w => f.min >= w.from && f.min <= w.to && f.spots >= w.players);
    if (ok) matches.push(f);
  }
  matches.sort((a, b) => a.date.localeCompare(b.date) || a.min - b.min);
  log(`read ${all.length} tee times; ${matches.length} new match(es); errors: ${errors.join('; ') || 'none'}`);
  for (const m of matches) log(`  ${m.date} ${fmt(m.min)} ${m.course} ${m.spots} spots${m.price != null ? ' $' + m.price : ''}`);

  if (matches.length && !DRY) {
    const top = matches[0];
    const line = m => `${niceDate(m.date)} ${fmt(m.min)} – ${m.course} – ${m.spots} spots${m.price != null ? ' – $' + m.price : ''}`;
    let msg = `🚨 *TEE TIME OPEN – BOOK NOW*\n*${line(top)}*\n${top.link}`;
    for (const m of matches.slice(1, MAX_LINES)) msg += `\n${line(m)} – book: ${m.link}`;
    if (matches.length > MAX_LINES) {
      const byDate = {}; for (const m of matches.slice(MAX_LINES)) byDate[m.date] = (byDate[m.date] || 0) + 1;
      msg += `\n…and ${matches.length - MAX_LINES} more: ` + Object.entries(byDate).map(([d, n]) => `${niceDate(d)} ${n} more – https://www.golfnow.com/tee-times/search#facilitytype=GolfCourse&date=${gnDate(d)}&longitude=${CENTER.lng}&latitude=${CENTER.lat}&radius=${RADIUS}&players=${playersByDate[d]}`).join('; ');
    }
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
