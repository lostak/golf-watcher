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
  { page: 'https://app.membersports.com/tee-times/3748/4817/0/0/0', label: 'CommonGround' },
  { page: 'https://app.membersports.com/tee-times/3663/4714/0/0/0', label: 'Coal Creek' },
  ...(cfg.memberSports || []),
];
// Chronogolf (Lightspeed) clubs: South Suburban district, Arvada, Riverdale, Lakewood. Slugs are the club page URLs.
const CHRONO = cfg.chronogolf || ['south-suburban-golf-club', 'lone-tree-golf-club-hotel', 'littleton-golf-tennis-club', 'family-sports-golf-course',
  'west-woods-golf-club', 'lake-arbor-golf-club', 'lake-arbor-golf-course', 'riverdale-dunes-knolls', 'fox-hollow-golf-club--2', 'the-homestead-golf-club-at-fox-hollow'];
// ForeUP booking pages (none by default: ForeUP needs a booking-class pick before it shows times)
const FOREUP = cfg.foreup || [];
const MIN_HOLES = cfg.minHoles || 18;

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

// ---------- GolfNow: every course within the radius ----------
// 1) the area-search page's own "courses-near-me" call gives the list of facilities (id, name, location);
// 2) a facility page's own "tee-time-results" call gives the request template, replayed per facility and date.
function walk(x, fn, depth = 0) { if (!x || typeof x !== 'object' || depth > 6) return; fn(x); for (const v of Object.values(x)) walk(v, fn, depth + 1); }
function gnMinutes(t) {
  const iso = t.time && (t.time.time || t.time.iso || t.time.dateTime || (typeof t.time === 'string' ? t.time : null));
  if (iso && /T\d\d:\d\d/.test(iso)) { const [, hh, mm] = iso.match(/T(\d\d):(\d\d)/); return +hh * 60 + +mm; }
  const f = (t.time && (t.time.formatted || t.time.formattedTime)) || t.formattedTime, mer = (t.time && t.time.formattedTimeMeridian) || t.formattedTimeMeridian;
  if (!f) return null;
  const [hh, mm] = String(f).split(':').map(Number);
  return ((mer === 'PM' && hh !== 12) ? hh + 12 : (mer === 'AM' && hh === 12) ? 0 : hh) * 60 + mm;
}
const miles = (a, b) => { const r = Math.PI / 180, dl = (b.lng - a.lng) * r * Math.cos((a.lat + b.lat) / 2 * r), dp = (b.lat - a.lat) * r; return 3959 * Math.sqrt(dl * dl + dp * dp); };
async function capture(p, url, re, waitMs = 25000) {
  let req; const seen = new Set();
  const onReq = r => { if (re.test(r.url())) req = r; if (DEBUG && /golfnow\.com\/api/i.test(r.url())) seen.add(r.method() + ' ' + r.url()); };
  p.on('request', onReq);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < waitMs / 500 && !req; i++) await p.waitForTimeout(500);
  p.off('request', onReq);
  if (!req) { dbg('api calls seen:', [...seen]); return null; }
  const h = req.headers(); delete h['content-length'];
  return { url: req.url(), method: req.method(), headers: h, body: req.postData() ? JSON.parse(req.postData()) : null };
}
async function replay(p, tpl, body) {
  const text = await p.evaluate(async ({ u, m, h, body }) => (await fetch(u, { method: m, headers: h, body: body == null ? undefined : JSON.stringify(body) })).text(),
    { u: tpl.url, m: tpl.method, h: tpl.headers, body });
  try { return JSON.parse(text); } catch (e) { throw new Error('non-JSON from ' + tpl.url + ': ' + text.slice(0, 60)); }
}
async function readGolfNow(browser, dates, playersByDate) {
  const found = [], p = await browser.newPage();
  const first = dates[0];
  // 1) facilities near the center
  const area = `https://www.golfnow.com/tee-times/search#facilitytype=GolfCourse&date=${gnDate(first)}&longitude=${CENTER.lng}&latitude=${CENTER.lat}&radius=${RADIUS}&players=${playersByDate[first]}&sortby=Facilities.Distance.0`;
  const near = await capture(p, area, /courses-near-me|tee-time-results|tee-time-search-results/i);
  if (!near) throw new Error('no course-search call seen on the GolfNow area page');
  dbg('near-me call:', near.method, near.url, 'body keys:', near.body ? Object.keys(near.body).join(',') : '(none)');
  let nb = near.body;
  if (nb) { const setk = (name, v) => { const k = Object.keys(nb).find(x => x.toLowerCase() === name); if (k) nb[k] = v; };
    setk('latitude', CENTER.lat); setk('longitude', CENTER.lng); setk('radius', RADIUS); setk('pagesize', 500); setk('pagenumber', 0); setk('teetimecount', 1); }
  const nj = await replay(p, near, nb);
  if (DEBUG) dbg('near-me response:', JSON.stringify(nj).slice(0, 1500));
  const facs = new Map();
  walk(nj, o => {
    const id = o.facilityId || (o.facility && o.facility.id) || (typeof o.id === 'number' && (o.name || o.facilityName) ? o.id : null);
    const name = o.name || o.facilityName || (o.facility && o.facility.name);
    const lat = o.latitude || (o.address && o.address.latitude) || (o.facility && o.facility.latitude), lng = o.longitude || (o.address && o.address.longitude) || (o.facility && o.facility.longitude);
    if (id && name && typeof name === 'string' && !facs.has(id)) facs.set(id, { id, name, slug: o.seoFriendlyName || (o.facility && o.facility.seoFriendlyName) || id, lat, lng });
  });
  let list = [...facs.values()].filter(f => wanted(f.name));
  if (list.some(f => f.lat && f.lng)) list = list.filter(f => !(f.lat && f.lng) || miles(CENTER, f) <= RADIUS + 1);
  log(`GolfNow: ${list.length} courses within ${RADIUS} mi: ${list.map(f => f.name).sort().join(', ') || '(none)'}`);
  if (!list.length) { await p.close(); return found; }
  // 2) the tee-sheet call template, captured from one facility page
  const tplFac = list[0];
  const tpl = await capture(p, `https://www.golfnow.com/tee-times/facility/${tplFac.slug}/search#date=${gnDate(first)}&players=${playersByDate[first]}`, /tee-time-results|tee-time-search-results/i);
  if (!tpl || !tpl.body) throw new Error('no tee-sheet call seen on a GolfNow facility page');
  dbg('tee-sheet call:', tpl.method, tpl.url, 'body:', JSON.stringify(tpl.body).slice(0, 600));
  const idKey = Object.keys(tpl.body).find(k => /facilityid/i.test(k)) || 'FacilityId';
  const dateKey = Object.keys(tpl.body).find(k => /^date$/i.test(k)) || 'Date';
  const playersKey = Object.keys(tpl.body).find(k => /^players$/i.test(k));
  let firstDump = true;
  for (const date of dates) for (const f of list) {
    const body = { ...tpl.body, [idKey]: f.id, [dateKey]: gnDate(date).replace(/\+/g, ' ') };
    for (const [k, v] of [['pagesize', 200], ['pagenumber', 0], ['teetimecount', 200]]) { const kk = Object.keys(body).find(x => x.toLowerCase() === k); if (kk) body[kk] = v; }
    if (playersKey) body[playersKey] = typeof tpl.body[playersKey] === 'number' ? playersByDate[date] : String(playersByDate[date]);
    if ('TimeMin' in body) body.TimeMin = 10; if ('TimeMax' in body) body.TimeMax = 42;
    let j; try { j = await replay(p, tpl, body); } catch (e) { dbg(f.name, e.message); continue; }
    if (DEBUG && firstDump) { dbg('tee-sheet response sample:', JSON.stringify(j).slice(0, 1200)); firstDump = false; }
    const tts = (j.ttResults && j.ttResults.teeTimes) || j.teeTimes || [];
    dbg(`${f.name} ${date}: ${tts.length} tee times`);
    for (const t of tts) {
      const min = gnMinutes(t); if (min == null) continue;
      const rate = t.displayRate != null ? t.displayRate : (t.minTeeTimeRate && t.minTeeTimeRate.value);
      const price = typeof rate === 'object' && rate ? rate.value : rate;
      const link = `https://www.golfnow.com/tee-times/facility/${f.slug}/search#date=${gnDate(date)}&players=${playersByDate[date]}`;
      found.push({ date, min, course: f.name, spots: playersByDate[date], price: typeof price === 'number' ? price : undefined, link, key: `${date}|${f.name}|${min}` });
    }
  }
  await p.close(); return found;
}

// ---------- Chronogolf (Lightspeed) ----------
const denverMinutes = iso => { const d = new Date(iso); const [h, m] = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: TZ }).split(':').map(Number); return (h % 24) * 60 + m; };
async function readChronogolf(browser, slug, dates) {
  const found = [], p = await browser.newPage();
  const tpl = await capture(p, `https://www.chronogolf.com/club/${slug}?date=${dates[0]}`, /marketplace\/v2\/teetimes\?/i, 12000);
  if (!tpl) { const ok = !/page not found|404/i.test(await p.title()); await p.close(); throw new Error(ok ? 'no tee sheet shown (online booking closed for now?) – slug may be wrong' : 'club page not found – slug may be wrong'); }
  const club = (await p.title()).replace(/\s*[|–-]\s*Chronogolf.*$/i, '').trim() || slug;
  for (const date of dates) {
    const u = tpl.url.replace(/start_date=\d{4}-\d{2}-\d{2}/, 'start_date=' + date);
    const j = await replay(p, { ...tpl, url: u }, null);
    const tts = j.teetimes || [];
    dbg(`${club} ${date}: ${tts.length} tee times`);
    for (const t of tts) {
      const cname = (t.course && t.course.name) || '';
      const holes = t.course && t.course.holes;
      if (holes && holes < MIN_HOLES) continue;
      const name = /\b(course|club)\b/i.test(cname) && cname.length > 8 && !/^\s*(front|back)?\s*\d+\s*hole/i.test(cname) ? cname : `${club}${cname ? ' – ' + cname : ''}`;
      if (!wanted(name)) continue;
      const min = t.starts_at ? denverMinutes(t.starts_at) : (t.start_time ? hm(t.start_time) : null); if (min == null) continue;
      const spots = t.max_player_size || 4, price = t.default_price && t.default_price.green_fee;
      found.push({ date, min, course: name, spots, price: typeof price === 'number' ? price : undefined, link: `https://www.chronogolf.com/club/${slug}?date=${date}`, key: `${date}|${name}|${min}` });
    }
  }
  await p.close(); return found;
}

// ---------- ForeUP ----------
async function readForeUp(browser, site, dates) {
  const found = [], p = await browser.newPage();
  const tpl = await capture(p, site.page, /api\/booking\/times\?/i, 20000);
  if (!tpl) { await p.close(); throw new Error('no tee-sheet call on ' + site.page); }
  for (const date of dates) {
    const [y, mo, d] = date.split('-');
    const u = tpl.url.replace(/date=\d{2}-\d{2}-\d{4}/, `date=${mo}-${d}-${y}`).replace(/players=\d/, 'players=0');
    const j = await replay(p, { ...tpl, url: u }, null);
    const tts = Array.isArray(j) ? j : [];
    dbg(`${site.label} ${date}: ${tts.length} tee times`);
    for (const t of tts) {
      const m = String(t.time || '').match(/(\d{2}):(\d{2})$/); if (!m) continue;
      if (t.holes && +t.holes < MIN_HOLES) continue;
      const name = site.label + (t.course_name && !new RegExp(site.label, 'i').test(t.course_name) ? ' – ' + t.course_name : '');
      if (!wanted(name)) continue;
      const min = +m[1] * 60 + +m[2], spots = +t.available_spots || 4, price = +t.green_fee;
      found.push({ date, min, course: name, spots, price: isNaN(price) ? undefined : price, link: site.page, key: `${date}|${name}|${min}` });
    }
  }
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
  const chronoOk = [];
  for (const slug of CHRONO) { try { const r = await readChronogolf(browser, slug, dates); chronoOk.push(slug); all = all.concat(r); } catch (e) { dbg(`Chronogolf ${slug}: ${e.message.slice(0, 100)}`); if (!/slug may be wrong/.test(e.message)) errors.push(`${slug}: ${e.message.slice(0, 80)}`); } }
  log(`Chronogolf: ${chronoOk.length}/${CHRONO.length} clubs read (${chronoOk.join(', ')})`);
  for (const s of FOREUP) { try { all = all.concat(await readForeUp(browser, s, dates)); } catch (e) { errors.push(`${s.label}: ${e.message.slice(0, 100)}`); } }
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
