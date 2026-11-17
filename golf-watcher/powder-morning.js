// Powder morning: on a morning when overnight new snow at one of Bradley's day-trip Ikon resorts reaches the threshold
// (powder-morning.json, default 6" in 24 h), send ONE Discord DM around 5:30 AM Denver with the resorts ranked by new
// snow and the drive from Denver, and hold the morning on his calendar. Runs from tick.yml every ~5 minutes; outside
// the morning window it exits at once. Free public data only, no keys, no Claude.
//
// Self-healing:
//   - New snow comes from the nearest SNOTEL snow stakes (USDA). If a stake has no fresh reading, the second stake is
//     used; if SNOTEL is down, Open-Meteo's modeled 24 h snowfall is used and the DM says so.
//   - Nothing is marked sent until the DM goes through, so a failed DM is retried on every tick until 8:30 AM. If the
//     DM still can't go, the calendar hold carries a popup instead (the same fallback watchdog.js uses).
//   - If no snow source can be read all morning, one DM at 8 AM says so (in season, once a day).
//
// Usage: node powder-morning.js [--test=<inches>] [--dry] [--force]
//   --test=9  simulate a 9" morning at the top resort (others scaled down), send ONE DM labelled TEST, touch no state,
//             and check calendar access read-only (no event is created).
//   --dry     print instead of sending; --force  ignore the time window and the once-a-day guard (no state written).
// Env: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID (DMs go to the server owner, never a channel), GCAL_SA_KEY, GCAL_CALENDAR_ID.
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'powder-morning.json'), 'utf8'));
const STATE = path.join(__dirname, 'state/powder-morning.json');
const TZ = 'America/Denver', UA = 'powder-morning (github.com/lostak/golf-watcher)';
const arg = n => { const a = process.argv.find(x => x === '--' + n || x.startsWith('--' + n + '=')); return a ? (a.split('=')[1] ?? true) : null; };
const TEST = arg('test') != null ? Math.max(1, +arg('test') || 9) : null, DRY = !!arg('dry'), FORCE = !!arg('force') || TEST != null;
const one = v => String(v || '').split(/\s+/).filter(Boolean)[0] || '';
const log = (...a) => console.log('powder-morning:', ...a);
const rnd = x => Math.round(x * 10) / 10;

const local = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, md: `${p.month}-${p.day}`, hour: +p.hour + (+p.minute) / 60, clock: d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) };
};
const now = local();
const inSeason = () => { const { from, to } = cfg.season || { from: '01-01', to: '12-31' }; return from <= to ? (now.md >= from && now.md <= to) : (now.md >= from || now.md <= to); };

async function getJSON(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`${r.status} ${new URL(url).host}`);
      return await r.json();
    } catch (e) { last = e; if (i + 1 < tries) await new Promise(r => setTimeout(r, 4000 * (i + 1))); }
  }
  throw last;
}

// ---------- new snow, last 24 h ----------
// SNOTEL hourly snow depth: new snow = (median of the last 3 readings) - (lowest reading 24-30 h ago). Readings older than
// 6 h, or jumps over 40" (sensor glitch), don't count.
async function snotel(ids) {
  const end = new Date(), begin = new Date(end.getTime() - 32 * 3600e3), f = d => d.toISOString().slice(0, 16).replace('T', ' ');
  const rows = await getJSON(`https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=${encodeURIComponent(ids.join(','))}&elements=SNWD&duration=HOURLY&beginDate=${encodeURIComponent(f(begin))}&endDate=${encodeURIComponent(f(end))}&periodRef=END`);
  const out = {};
  for (const row of rows || []) for (const el of row.data || []) {
    // SNOTEL hourly times are local standard time (UTC-7 for Colorado) without an offset
    const vals = (el.values || []).filter(v => v.value != null).map(v => ({ t: Date.parse(v.date.replace(' ', 'T') + ':00-07:00'), v: +v.value })).filter(v => !isNaN(v.t)).sort((a, b) => a.t - b.t);
    if (vals.length < 6) continue;
    const last = vals[vals.length - 1];
    if (Date.now() - last.t > 6 * 3600e3) continue;
    const recent = vals.slice(-3).map(v => v.v).sort((a, b) => a - b)[1];
    const old = vals.filter(v => v.t <= last.t - 24 * 3600e3);
    if (!old.length) continue;
    const base = Math.min(...old.slice(-6).map(v => v.v));
    const inches = Math.max(0, recent - base);
    if (inches > 40) continue;
    out[row.stationTriplet] = { inches, depth: recent, at: last.t };
  }
  return out;
}
// Open-Meteo modeled snowfall (cm per hour) summed over the last 24 h; one request for all the resorts that need it.
const sum24 = h => {
  const nowMs = Date.now(); let cm = 0, n = 0;
  for (let i = 0; i < h.time.length; i++) { const ms = Date.parse(h.time[i] + ':00Z'); if (ms > nowMs - 24 * 3600e3 && ms <= nowMs) { cm += h.snowfall[i] || 0; n++; } }
  if (n < 18) throw new Error('Open-Meteo: short series');
  return cm / 2.54;
};
async function openMeteo(rs) {
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${rs.map(r => r.lat).join(',')}&longitude=${rs.map(r => r.lng).join(',')}&hourly=snowfall&past_days=2&forecast_days=1&timezone=UTC`, 3);
  const arr = Array.isArray(j) ? j : [j];
  return Object.fromEntries(rs.map((r, i) => [r.name, sum24(arr[i].hourly)]));
}
async function readSnow() {
  const errors = [], snow = {};
  let st = {};
  const ids = [...new Set(cfg.resorts.flatMap(r => r.snotel || []))];
  try { st = await snotel(ids); } catch (e) { errors.push('SNOTEL ' + why(e)); }
  const missing = [];
  for (const r of cfg.resorts) {
    const id = (r.snotel || []).find(i => st[i]);
    if (id) snow[r.name] = { inches: st[id].inches, source: 'snotel' }; else missing.push(r);
  }
  if (missing.length) {
    try { for (const [n, inches] of Object.entries(await openMeteo(missing))) snow[n] = { inches, source: 'model' }; }
    catch (e) { errors.push('Open-Meteo ' + why(e)); }
  }
  return { snow, errors };
}
const why = e => `${e.message}${e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''}`.slice(0, 90);

// ---------- delivery ----------
const TOKEN = one(process.env.DISCORD_BOT_TOKEN), CHANNEL = one(process.env.DISCORD_CHANNEL_ID);
const dapi = async (method, p, body) => {
  const r = await fetch('https://discord.com/api/v10' + p, { method, headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Discord ${p.split('/')[1]} ${r.status}`); return r.json();
};
// DMs only: the bot opens a DM with the server's owner (Bradley). Never posts in a channel.
async function dm(st, text) {
  if (DRY) { log('(dry) would DM:\n' + text); return; }
  if (!TOKEN || !CHANNEL) throw new Error('Discord bot not configured');
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      if (!st.dmId) { const ch = await dapi('GET', `/channels/${CHANNEL}`); const owner = (await dapi('GET', `/guilds/${ch.guild_id}`)).owner_id; st.dmId = (await dapi('POST', '/users/@me/channels', { recipient_id: owner })).id; }
      await dapi('POST', `/channels/${st.dmId}/messages`, { content: text.slice(0, 1990), allowed_mentions: { parse: [] } });
      return;
    } catch (e) { err = e; if (/ 40[134]$/.test(e.message)) delete st.dmId; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
  throw err;
}

function message(ranked, top, source, test) {
  const lines = ranked.map((x, i) => `${i + 1}. **${x.r.name}** ${Math.round(x.inches)}" · ~${x.r.drive} via ${x.r.route}`);
  const modeled = ranked.some(x => x.source !== 'snotel');
  return [
    `${test ? '🧪 **TEST, simulated snow day (ignore)** · ' : ''}❄️ **Powder morning: ${top.r.name} ${Math.round(top.inches)}" overnight**`,
    ...lines,
    `I-70 and passes right now: https://www.cotrip.org/`,
    `${top.r.name} snow report: ${top.r.snowReport}`,
    `_New snow in the last 24 h at the nearest SNOTEL snow stake${modeled ? '; some resorts from a weather model because the stake data was unavailable' : ''}. Drive times are typical dry-road times from ${cfg.origin}._`,
  ].join('\n');
}

async function holdMorning(st, top, dmFailed) {
  const gcal = require('./gcal');
  if (!gcal.ready) return 'skipped (no calendar secrets)';
  if (TEST != null) { await gcal.search('powder morning', { back: 1, ahead: 1, max: 1 }); return 'access ok (test: no event created)'; }
  if (DRY) return 'dry';
  const existing = await gcal.findByTitle(/^Personal: powder morning/i, 'powder morning', { back: 0.5, ahead: 1 });
  if (existing) return 'already held';
  const [h, m] = (cfg.hold.start || '06:30').split(':').map(Number);
  // start = today h:m Denver; Denver's offset now (MST/MDT) from Intl
  const off = new Date(new Date().toLocaleString('en-US', { timeZone: TZ })) - new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
  let when = new Date(Date.parse(`${now.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - off);
  // Discord failed: start the hold 31 min out so Bradley's default 30-minute popup fires about now (as watchdog.js does)
  if (dmFailed) when = new Date(Math.max(when.getTime(), Date.now() + 31 * 60e3));
  await gcal.insert({
    summary: `Personal: powder morning – ${top.r.name} ${Math.round(top.inches)}"`,
    description: `${st.lastText || ''}\nPOWDER-MORNING: ${now.date}\nHeld automatically by golf-watcher/powder-morning.js (delete it if you're not going).`,
    when, minutes: cfg.hold.minutes || 360, popup: dmFailed ? 0 : null,
  });
  return dmFailed ? 'held with popup (Discord failed)' : 'held';
}

(async () => {
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  st.days ||= {};
  for (const d of Object.keys(st.days)) if (d < new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10)) delete st.days[d];
  const day = (st.days[now.date] ||= { tries: 0 });
  const save = () => { if (TEST == null && !DRY && !arg('force')) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st, null, 1)); } };

  if (!FORCE) {
    if (!inSeason()) return log('out of season');
    if (now.hour < cfg.sendFrom || now.hour >= Math.max(cfg.sendUntil, cfg.failureReportAt + 0.5)) return log(`outside window (${now.clock})`);
    if (day.sent && day.cal) return log('already sent today: ' + day.sent);
  }
  // DM went out but the calendar hold failed: retry just the hold, without re-reading snow
  if (!FORCE && day.sent && !day.cal && day.top) {
    try { day.cal = await holdMorning(st, { r: cfg.resorts.find(r => r.name === day.top.name) || { name: day.top.name }, inches: day.top.inches }, false); log('calendar retry: ' + day.cal); }
    catch (e) { log('calendar retry failed: ' + e.message.slice(0, 120)); if (now.hour >= cfg.sendUntil - 0.25) day.cal = 'gave up: ' + e.message.slice(0, 80); }
    save(); return;
  }

  // failure report: no snow source worked all morning
  if (!FORCE && now.hour >= cfg.failureReportAt && !day.ok && day.tries >= 3 && !day.failDm) {
    try { await dm(st, `⚠️ **Powder morning check couldn't read any snow data this morning** (${(day.lastErr || 'unknown').slice(0, 200)}). It tried ${day.tries} times and will try again tomorrow. Today's snow: https://www.cotrip.org/ and the resort reports.`); day.failDm = new Date().toISOString(); }
    catch (e) { log('failure DM failed too: ' + e.message); }
    save(); return;
  }
  if (!FORCE && now.hour >= cfg.sendUntil) { save(); return log('past send window'); }

  day.tries++;
  const { snow, errors } = await readSnow();
  if (errors.length) log('source problems: ' + errors.join('; '));
  if (!Object.keys(snow).length && TEST == null) { day.lastErr = errors.join('; '); save(); log('no snow data this tick, will retry next tick'); process.exitCode = 0; return; }
  day.ok = true;

  let ranked = cfg.resorts.filter(r => snow[r.name] || TEST != null).map(r => ({ r, ...(snow[r.name] || { inches: 0, source: 'none' }) })).sort((a, b) => b.inches - a.inches);
  log('new snow: ' + ranked.map(x => `${x.r.name} ${rnd(x.inches)}" (${x.source})`).join(', '));
  if (TEST != null) {  // simulated morning: top resort gets TEST inches, the rest step down, real ordering otherwise kept
    ranked = ranked.map((x, i) => ({ ...x, inches: Math.max(0, TEST - i * 2) }));
  }
  const top = ranked[0];
  if (!top || top.inches < cfg.thresholdInches) { day.best = top ? `${top.r.name} ${rnd(top.inches)}"` : '-'; save(); return log(`below ${cfg.thresholdInches}" (best ${day.best})`); }

  const text = message(ranked, top, null, TEST != null);
  st.lastText = text.replace(/\*\*/g, '');
  day.top = { name: top.r.name, inches: top.inches };
  let dmErr = null;
  try { await dm(st, text); if (!DRY) log('DM sent'); } catch (e) { dmErr = e; day.dmErr = e.message; log('DM failed: ' + e.message + ' (retrying next tick)'); }
  if (!dmErr) day.sent = `${top.r.name} ${rnd(top.inches)}" at ${now.clock}`;
  // Calendar: silent hold once the DM is out. If Discord keeps failing until the end of the window, the hold carries a
  // popup instead so the news still reaches his phone.
  const lastChance = now.hour >= cfg.sendUntil - 0.25;
  if (!dmErr || lastChance) {
    try { day.cal = await holdMorning(st, top, !!dmErr); if (dmErr && /^held/.test(day.cal)) day.sent = `calendar popup only (Discord failed) at ${now.clock}`; }
    catch (e) { log('calendar failed: ' + e.message.slice(0, 120)); if (lastChance) day.cal = 'gave up: ' + e.message.slice(0, 80); }
    log('calendar: ' + (day.cal || 'will retry'));
  }
  save();
  if (dmErr && TEST != null) process.exitCode = 1;
})().catch(e => { console.error('powder-morning:', e.stack || e.message); process.exit(1); });
