// Reads new messages in the Discord golf channel and turns them into wants.json changes.
// Runs every 5 minutes on GitHub Actions (.github/workflows/commands.yml). Needs DISCORD_BOT_TOKEN (a bot in the
// server with Read Message History + the Message Content intent), DISCORD_CHANNEL_ID, and DISCORD_WEBHOOK_URL for replies.
//
// Things Bradley can post:
//   watch Sat 7-11 for 4                        → all courses, Saturday 7:00–11:00, 4 players
//   watch Sat and Sun morning for 2 at Murphy Creek, Meadow Hills
//   tee time Nov 14 7:30-10 for 3 at Wellshire
//   stop Sat   /   stop all                       → remove those wants
//   list                                          → what's being watched
// Exit code 3 means wants.json changed (the workflow then commits and wakes the watcher).
'use strict';
const fs = require('fs');
const TZ = 'America/Denver';
const WANTS = 'wants.json', STATE = 'state/discord.json', COURSES = 'state/courses.json';
const token = process.env.DISCORD_BOT_TOKEN, channel = process.env.DISCORD_CHANNEL_ID, hook = process.env.DISCORD_WEBHOOK_URL;
if (!token || !channel) { console.log('DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID not set – skipping.'); process.exit(0); }

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const nice = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = hm => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseDates(text) {
  const t = today(), out = [];
  let m;
  const re = /\b(today|tomorrow|(?:this |next )?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/gi;
  while ((m = re.exec(text))) {
    const w = m[1].toLowerCase();
    if (w === 'today') out.push(t);
    else if (w === 'tomorrow') out.push(addDays(t, 1));
    else if (m[2]) { const want = DAYS.findIndex(d => d.startsWith(m[2].toLowerCase().slice(0, 3))); let d = t; for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (dow(d) === want) break; if (/^next /.test(w) && d === t) d = addDays(d, 7); out.push(d); }
    else if (m[3]) out.push(`${m[3]}-${m[4]}-${m[5]}`);
    else if (m[6]) out.push(nextOf(+m[6], +m[7]));
    else if (m[8]) out.push(nextOf(MONTHS.indexOf(m[8].toLowerCase()) + 1, +m[9]));
    else if (m[10]) out.push(nextOf(MONTHS.indexOf(m[11].toLowerCase()) + 1, +m[10]));
  }
  function nextOf(mo, d) { const y = +t.slice(0, 4); let s = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; if (s < t) s = `${y + 1}` + s.slice(4); return s; }
  return [...new Set(out)].filter(d => d >= t).sort();
}
function parseWindow(text) {
  const t = text.toLowerCase();
  if (/\bmorning\b/.test(t)) return ['07:00', '11:00'];
  if (/\bafternoon\b/.test(t)) return ['12:00', '16:00'];
  if (/\btwilight\b|\bevening\b/.test(t)) return ['15:00', '19:00'];
  if (/\ball day\b|\banytime\b/.test(t)) return ['06:00', '19:00'];
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return ['07:00', '11:00'];
  let h1 = +m[1], h2 = +m[4];
  if (m[3] === 'pm' && h1 < 12) h1 += 12; if (m[6] === 'pm' && h2 < 12) h2 += 12;
  if (!m[3] && !m[6] && h1 <= 5) { h1 += 12; h2 += 12; }          // "1-4" means afternoon
  if (!m[6] && h2 <= h1) h2 += 12;                                   // "9-1" means 9 AM to 1 PM
  if (h2 > 21) h2 = 21;
  return [`${String(h1).padStart(2, '0')}:${m[2] || '00'}`, `${String(h2).padStart(2, '0')}:${m[5] || '00'}`];
}
function parsePlayers(text) {
  const t = text.toLowerCase();
  const m = t.match(/\bfor (\d)\b|\b(\d) players?\b|\bx(\d)\b/);
  if (m) return +(m[1] || m[2] || m[3]);
  if (/foursome/.test(t)) return 4; if (/threesome/.test(t)) return 3; if (/single|just me|solo/.test(t)) return 1;
  return 2;
}
function parseCourses(text) {
  const known = fs.existsSync(COURSES) ? JSON.parse(fs.readFileSync(COURSES, 'utf8')) : [];
  const out = new Set();
  const after = text.match(/\b(?:at|@)\s+(.+)$/i);
  const named = after ? after[1].split(/,|\band\b|&/).map(s => s.replace(/\b(for \d|golf course|golf club)\b/gi, '').trim()).filter(s => s && !/^\d/.test(s)) : [];
  for (const n of named) { const hit = known.find(k => k.toLowerCase().includes(n.toLowerCase())); out.add(hit || n); }
  for (const k of known) { const key = k.split(/\s+/).filter(w => w.length > 3 && !/^(golf|course|club|the|colorado)$/i.test(w))[0]; if (key && new RegExp('\\b' + key + '\\b', 'i').test(text)) out.add(k); }
  return [...out];
}

async function discord(path, opts = {}) {
  const r = await fetch('https://discord.com/api/v10' + path, { ...opts, headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Discord ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function reply(text) { console.log('reply:', text); if (hook) await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1990) }) }); }

(async () => {
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const cfg = JSON.parse(fs.readFileSync(WANTS, 'utf8'));
  let msgs;
  if (!st.last) {                                                     // first run: start from now, don't replay old messages
    msgs = await discord(`/channels/${channel}/messages?limit=1`);
    st.last = msgs[0] ? msgs[0].id : '0'; msgs = [];
    console.log('First run – cursor set, nothing processed.');
  } else msgs = (await discord(`/channels/${channel}/messages?after=${st.last}&limit=50`)).reverse();
  let changed = false;
  for (const msg of msgs) {
    st.last = msg.id;
    if (msg.author?.bot || msg.webhook_id) continue;
    const text = (msg.content || '').trim(); if (!text) continue;
    const t = text.toLowerCase();
    console.log('message:', text);
    const before = cfg.wants.length;
    if (/^(list|status|what.*watch)/.test(t)) {
      const open = cfg.wants.filter(w => w.date >= today());
      await reply(open.length ? 'Watching: ' + open.map(w => `${nice(w.date)} ${fmt(w.from)}–${fmt(w.to)} for ${w.players}${w.courses ? ' at ' + w.courses.join(', ') : ''}`).join(' · ') : 'Not watching any days. Post "watch Sat 7-11 for 4" to start.');
      continue;
    }
    if (/^(stop|cancel|remove|clear|drop)\b/.test(t)) {
      if (/\ball\b|everything/.test(t)) cfg.wants = [];
      else { const ds = parseDates(text); cfg.wants = cfg.wants.filter(w => !ds.includes(w.date)); if (!ds.length) { await reply('Which day? e.g. "stop Sat" or "stop all".'); continue; } }
      cfg.wants = cfg.wants.filter(w => w.date >= today());
      changed = changed || cfg.wants.length !== before;
      await reply(cfg.wants.length ? 'Stopped. Still watching: ' + cfg.wants.map(w => `${nice(w.date)} ${fmt(w.from)}–${fmt(w.to)} for ${w.players}`).join(' · ') : 'Stopped. Not watching any days now.');
      continue;
    }
    const dates = parseDates(text);
    if (!dates.length) { await reply(`Didn't catch a day in "${text.slice(0, 60)}". Try "watch Sat 7-11 for 4 at Murphy Creek" or "list" or "stop Sat".`); continue; }
    const [from, to] = parseWindow(text), players = parsePlayers(text), courses = parseCourses(text);
    for (const date of dates) {
      cfg.wants = cfg.wants.filter(w => !(w.date === date && w.from === from && w.to === to));
      const w = { date, from, to, players }; if (courses.length) w.courses = courses;
      cfg.wants.push(w);
    }
    cfg.wants = cfg.wants.filter(w => w.date >= today()).sort((a, b) => a.date.localeCompare(b.date) || a.from.localeCompare(b.from));
    changed = true;
    await reply(`Got it – watching ${dates.map(nice).join(', ')} ${fmt(from)}–${fmt(to)} for ${players}${courses.length ? ' at ' + courses.join(', ') : ' at every public course within 40 miles'}. I check every 5 minutes, 5 AM–10 PM, and post here the moment something opens.`);
  }
  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st));
  if (changed) { fs.writeFileSync(WANTS, JSON.stringify(cfg, null, 2) + '\n'); console.log('wants.json changed'); process.exit(3); }
  console.log(`${msgs.length} message(s), no change.`);
})().catch(e => { console.error(e); process.exit(1); });
