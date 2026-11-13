// Reads new messages in the Discord golf channel and turns them into wants.json changes.
// Runs every 5 minutes on GitHub Actions (.github/workflows/commands.yml). Needs DISCORD_BOT_TOKEN (a bot in the
// server with Read Message History + the Message Content intent), DISCORD_CHANNEL_ID, and DISCORD_WEBHOOK_URL for replies.
//
// Things Bradley can post (plain English, any order, typos OK – see HELP below):
//   watch Sat 9-10 for 4 at Kennedy             → Saturday 9:00–10:00, 4 players, ONLY Kennedy
//   kennedy saturday morning foursome / wellshire or city park tomorrow after 2 for 2 / this weekend before 11
//   no course named                              → that day uses the usual course list (calendar COURSE lines)
//   stop Sat / stop Kennedy / stop Kennedy Sat / stop all · list · courses · report · help
// Exit code 3 means wants.json changed (the workflow then commits and wakes the watcher).
'use strict';
const fs = require('fs');
const gcal = require('./gcal');   // when configured, the "Personal: golf watch" calendar event is the source of truth (shared with the app and Pocket)
const TZ = 'America/Denver';
const WANTS = 'wants.json', STATE = 'state/discord.json', COURSES = 'state/courses.json';
// secrets pasted from a clipboard can carry a line break or a second copy – keep the first word only
const one = v => String(v || '').split(/\s+/).filter(Boolean)[0] || '';
const token = one(process.env.DISCORD_BOT_TOKEN), channel = one(process.env.DISCORD_CHANNEL_ID), hook = one(process.env.DISCORD_WEBHOOK_URL);
const TEXT = (() => { const i = process.argv.indexOf('--text'); return i > -1 ? process.argv[i + 1] : null; })();   // one command passed in (from Pocket via Claude) instead of reading Discord
if (!TEXT && (!token || !channel)) { console.log('DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID not set – skipping.'); process.exit(0); }

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const nice = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmt = hm => { const [h, m] = hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---- understanding what Bradley types (lenient on purpose: plain English, typos, any order) ----
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, single: 1, solo: 1, pair: 2, couple: 2, twosome: 2, threesome: 3, foursome: 4 };
// Denver-area courses people name, beyond whatever the watcher has seen (state/courses.json). Short names match every
// tee sheet of that course ("Kennedy" covers Babe Lind / West and the Creek 9).
const KNOWN_COURSES = ['City Park', 'Wellshire', 'Kennedy', 'Overland Park', 'Willis Case', 'Harvard Gulch', 'Evergreen', 'Foothills',
  'Murphy Creek', 'Saddle Rock', 'Meadow Hills', 'Aurora Hills', 'Springhill', 'Fitzsimons', 'Indian Tree', 'Common Ground', 'Coal Creek',
  'Riverdale', 'Fox Hollow', 'Homestead', 'West Woods', 'Lake Arbor', 'South Suburban', 'Lone Tree', 'Littleton', 'Family Sports',
  'Arrowhead', 'Raccoon Creek', 'Hyland Hills', 'Thorncreek', 'Legacy Ridge', 'Heritage Eagle Bend', 'Green Valley Ranch', 'Buffalo Run'];
function lev(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length]; }
const shortName = c => String(c).replace(/\s*\(.*\)\s*$/, '').replace(/\b(golf|course|club|the|links|18)\b/gi, '').replace(/\s+/g, ' ').trim();
function courseNames() {
  const seen = fs.existsSync(COURSES) ? JSON.parse(fs.readFileSync(COURSES, 'utf8')) : [];
  return [...new Set([...KNOWN_COURSES, ...seen.map(shortName)].filter(Boolean))];
}
// every course named anywhere in the text, typo-tolerant ("kenedy", "wellshir", "murphy crk")
function parseCourses(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean), out = [];
  for (const name of courseNames()) {
    const target = name.toLowerCase().split(' '), n = target.length;
    for (let i = 0; i + n <= words.length; i++) {
      const got = words.slice(i, i + n).join(' '), want = target.join(' ');
      const tol = want.length >= 9 ? 2 : want.length >= 5 ? 1 : 0;
      if (got === want || (tol && lev(got, want) <= tol) || (n > 1 && words[i] === target[0] && want.length > 6 && lev(words.slice(i, i + n).join(' '), want) <= 3)) { out.push(name); break; }
    }
  }
  return [...new Set(out)];
}
function parseDates(text) {
  const t = today(), out = [], weekdays = [];
  const s = text.toLowerCase();
  if (/\b(this |next )?weekend\b/.test(s)) { let d = t; while (dow(d) !== 6) d = addDays(d, 1); if (/next weekend/.test(s) && addDays(d, -7) >= t) d = addDays(d, 7); out.push(d, addDays(d, 1)); }
  let m;
  const re = /\b(today|tonight|tomorrow|tmrw|tmr|(?:this |next )?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)s?|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)? (?:of )?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|the (\d{1,2})(?:st|nd|rd|th))\b/gi;
  while ((m = re.exec(text))) {
    const w = m[1].toLowerCase();
    if (w === 'today' || w === 'tonight') out.push(t);
    else if (/^(tomorrow|tmrw|tmr)$/.test(w)) out.push(addDays(t, 1));
    else if (m[2]) { const want = DAYS.findIndex(d => d.startsWith(m[2].toLowerCase().slice(0, 3))); let d = t; for (let i = 0; i < 7; i++, d = addDays(d, 1)) if (dow(d) === want) break; if (/^next /.test(w) && (d === t || dow(t) <= want)) d = addDays(d, 7); weekdays.push(d); }
    else if (m[3]) out.push(`${m[3]}-${m[4]}-${m[5]}`);
    else if (m[6]) out.push(nextOf(+m[6], +m[7]));
    else if (m[8]) out.push(nextOf(MONTHS.indexOf(m[8].toLowerCase().slice(0, 3)) + 1, +m[9]));
    else if (m[10]) out.push(nextOf(MONTHS.indexOf(m[11].toLowerCase().slice(0, 3)) + 1, +m[10]));
    else if (m[12]) { const d = +m[12]; let s2 = t.slice(0, 8) + String(d).padStart(2, '0'); if (s2 < t) { const x = new Date(t + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + 1, d); s2 = x.toISOString().slice(0, 10); } out.push(s2); }
  }
  function nextOf(mo, d) { const y = +t.slice(0, 4); let s2 = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; if (s2 < t) s2 = `${y + 1}` + s2.slice(4); return s2; }
  // "Sat 11/21": a weekday next to an explicit date names that date, not this week's Saturday
  for (const d of weekdays) if (!out.some(x => dow(x) === dow(d))) out.push(d);
  return [...new Set(out)].filter(d => d >= t).sort();
}
const ALL_DAY = ['05:00', '21:00'];
const win = (from, to) => (from === ALL_DAY[0] && to === ALL_DAY[1] ? 'any time (daylight)' : `${fmt(from)}–${fmt(to)}`);
const hhmm = (h, m) => `${String(Math.max(5, Math.min(21, h))).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
function to24(h, ap, guessPm) { h = +h; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap && guessPm && h <= 5) h += 12; return h; }
function parseWindow(text) {
  // drop dates and player counts first so "11/14" or "for 4" never read as times
  const t = text.toLowerCase().replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(for|party of|x)\s*\d\b|\b\d\s*(players?|people|ppl|golfers|guys|of us)\b/g, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(st|nd|rd|th)?\b|\bthe \d{1,2}(st|nd|rd|th)\b/g, ' ')
    .replace(/\bnoon\b/g, '12pm');
  const T = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a|p)?\\b';
  let m = t.match(new RegExp(`(?:between|from)?\\s*\\b${T}\\s*(?:-|–|—|to|until|till|til|and|thru|through)\\s*${T}`));
  if (m) {
    const ap1 = m[3] ? m[3][0] + 'm' : '', ap2 = m[6] ? m[6][0] + 'm' : '';
    let h1 = to24(m[1], ap1 || (ap2 === 'pm' && +m[1] < +m[4] ? 'pm' : ''), !ap1 && !ap2), h2 = to24(m[4], ap2, !ap1 && !ap2);
    if (!ap2 && h2 <= h1) h2 += 12;                                   // "9-1" = 9 AM to 1 PM
    return [hhmm(h1, m[2]), hhmm(Math.min(h2, 21), h2 >= 21 ? 0 : m[5])];
  }
  if ((m = t.match(new RegExp(`\\b(?:before|by|no later than)\\s+${T}`)))) return [ALL_DAY[0], hhmm(to24(m[1], m[3] ? m[3][0] + 'm' : '', true), m[2])];
  if ((m = t.match(new RegExp(`\\b(?:after|from|starting(?: at)?|no earlier than)\\s+${T}`)))) return [hhmm(to24(m[1], m[3] ? m[3][0] + 'm' : '', true), m[2]), ALL_DAY[1]];
  if ((m = t.match(new RegExp(`\\b(?:at|around|about|near|~)\\s+${T}`))) || (m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/))) {
    const h = to24(m[1], m[3] ? m[3][0] + 'm' : '', true), mins = h * 60 + +(m[2] || 0);
    return [hhmm(Math.floor((mins - 30) / 60), (mins - 30) % 60), hhmm(Math.floor((mins + 30) / 60), (mins + 30) % 60)];   // "around 9" = 8:30–9:30
  }
  if (/\b(early|first thing|dawn|sunrise)\b/.test(t)) return ['05:00', '09:00'];
  if (/\bmorning\b|\bam\b/.test(t)) return ['07:00', '11:00'];
  if (/\b(midday|mid-day|lunch)\b/.test(t)) return ['11:00', '14:00'];
  if (/\bafternoon\b|\bpm\b/.test(t)) return ['12:00', '16:00'];
  if (/\btwilight\b|\bevening\b|\blate\b/.test(t)) return ['15:00', '19:00'];
  return ALL_DAY;                                                    // no time given → any daylight time
}
function parsePlayers(text) {
  const t = text.toLowerCase();
  let m = t.match(/\b(?:for|party of|group of|x)\s*(\d|one|two|three|four)\b|\b(\d|one|two|three|four)\s*(?:players?|people|ppl|golfers|guys|of us|spots?|tee times?)\b/);
  if (m) { const v = m[1] || m[2]; return WORDNUM[v] || +v; }
  if ((m = t.match(/\bme (?:and|\+|&) (\d|one|two|three) (?:others?|friends?|buddies|guys|more)\b/))) return 1 + (WORDNUM[m[1]] || +m[1]);
  for (const [w, n] of Object.entries(WORDNUM)) if (n && new RegExp(`\\b${w}\\b`).test(t) && /some|single|solo|pair|couple/.test(w)) return n;
  if (/\bjust me\b|\bby myself\b/.test(t)) return 1;
  return null;                                                       // not said → keep the day's existing count, else 2
}
const HELP = [
  'Golf watcher – things you can post here (any order, typos OK):',
  '• watch Sat 9-10 for 4 at Kennedy   → only Kennedy',
  '• kennedy saturday morning foursome   /   wellshire or city park tomorrow after 2 for 2',
  '• this weekend before 11 for 3   (no course = your usual course list)',
  '• list   ·   courses   ·   stop Sat   ·   stop Kennedy   ·   stop all   ·   report',
].join('\n');

async function discord(path, opts = {}) {
  const r = await fetch('https://discord.com/api/v10' + path, { ...opts, headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Discord ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}
async function reply(text) {
  console.log('reply:', text);
  if (hook) await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1990) }) });
}

const wantText = w => `${nice(w.date)} ${win(w.from, w.to)} for ${w.players}${w.courses && w.courses.length ? ' – only ' + w.courses.join(', ') : ''}`;
const WANT_RE = /^\s*WANT:\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\s+(\d)\s*players?(?:\s+(?:at|only)\s+(.+?))?\s*$/gim;
const wantLine = w => `WANT: ${w.date} ${w.from}-${w.to} ${w.players} player${w.players > 1 ? 's' : ''}${w.courses && w.courses.length ? ' at ' + w.courses.join('; ') : ''}`;
const sameCourses = (a, b) => (a || []).map(x => x.toLowerCase()).sort().join('|') === (b || []).map(x => x.toLowerCase()).sort().join('|');

(async () => {
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const cfg = JSON.parse(fs.readFileSync(WANTS, 'utf8'));
  // Calendar mode: COURSE lines = the general list (for days that name no course); WANT lines carry their own courses
  // ("WANT: 2026-11-14 09:00-10:00 4 players at Kennedy") and those days match ONLY those courses.
  let golfEv = null, courseList = [], otherLines = [];
  if (gcal.ready) {
    golfEv = await gcal.findByTitle('Personal: golf watch', 'golf watch');
    const d = golfEv ? golfEv.description || '' : '';
    courseList = [...d.matchAll(/^\s*COURSE:\s*(.+?)\s*$/gm)].map(m => m[1]);
    cfg.wants = [...d.matchAll(WANT_RE)].map(m => ({ date: m[1], from: m[2].padStart(5, '0'), to: m[3].padStart(5, '0'), players: +m[4], courses: m[5] ? m[5].split(/\s*[;,]\s*/).filter(Boolean) : undefined }));
    otherLines = d.split('\n').filter(l => !/^\s*(COURSE:|WANT:|GOLF-WATCH)/.test(l) && l.trim());
    if (!otherLines.length) otherLines = ['Tee-time watch for the Life app. The tee-time task checks these courses for the WANT days and adds FOUND lines.'];
  }
  cfg.wants = (cfg.wants || []).filter(w => w.date >= today());
  const general = () => courseList.length ? courseList.map(shortName).join(', ') : 'every public course within 40 miles';
  let msgs;
  if (TEXT) msgs = [{ id: st.last, content: TEXT }];
  else if (!st.last) {                                                // first run: start from now, don't replay old messages
    msgs = await discord(`/channels/${channel}/messages?limit=1`);
    st.last = msgs[0] ? msgs[0].id : '0'; msgs = [];
    console.log('First run – cursor set, nothing processed.');
  } else msgs = (await discord(`/channels/${channel}/messages?after=${st.last}&limit=50`)).reverse();
  let changed = false, report = false;
  for (const msg of msgs) {
    st.last = msg.id;
    // a /slash command: the Cloudflare helper answers Discord with "⏳ `<command>` …"; that reply carries the command text
    const slash = (msg.interaction_metadata || msg.interaction) && /^⏳ `([^`]+)`/.exec(msg.content || '');
    if (!slash && (msg.author?.bot || msg.webhook_id)) continue;
    const text = (slash ? slash[1] : msg.content || '').replace(/^\/?golf\s+/i, '').trim(); if (!text) continue;
    const t = text.toLowerCase();
    console.log('message:', text);
    const dates = parseDates(text), named = parseCourses(text);
    const isStop = /^(stop|cancel|remove|clear|drop|delete|unwatch|forget|nevermind|never mind|no longer|don'?t watch)\b/.test(t) || /\b(stop|cancel) watching\b/.test(t);

    if (/^(help|\?|commands|how)\b/.test(t)) { await reply(HELP); continue; }
    if (/^(list|status|show|what('?s| am i| are you)? ?(being )?watch|watching\??$)/.test(t) || /\bwhat.*\bwatch/.test(t)) {
      await reply(cfg.wants.length ? 'Watching:\n' + cfg.wants.map(w => '• ' + wantText(w) + (w.courses && w.courses.length ? '' : ` – your usual courses`)).join('\n') + `\nYour usual courses: ${general()}.` : 'Not watching any days. Try "watch Sat 9-10 for 4 at Kennedy".');
      continue;
    }
    if (/^courses?\b/.test(t) && !dates.length) { await reply(`Your usual courses (for days that don't name one): ${general()}.\nCourses I can read tee times for: ${courseNames().join(', ')}.`); continue; }
    if (/^report\b/.test(t)) { report = true; await reply('Posting the golf report in a few minutes.'); continue; }

    if (isStop) {
      const before = JSON.stringify(cfg.wants);
      if (/\ball\b|everything/.test(t) && !named.length) cfg.wants = [];
      else if (dates.length && named.length) cfg.wants = cfg.wants.flatMap(w => { if (!dates.includes(w.date)) return [w]; if (!w.courses) return [w]; const left = w.courses.filter(c => !named.some(n => n.toLowerCase() === shortName(c).toLowerCase())); return left.length ? [{ ...w, courses: left }] : []; });
      else if (dates.length) cfg.wants = cfg.wants.filter(w => !dates.includes(w.date));
      else if (named.length) {
        // a course with no day: take it off every watched day that names it, and off the usual list
        cfg.wants = cfg.wants.flatMap(w => { if (!w.courses) return [w]; const left = w.courses.filter(c => !named.some(n => n.toLowerCase() === shortName(c).toLowerCase())); return left.length ? [{ ...w, courses: left }] : []; });
        const n0 = courseList.length; courseList = courseList.filter(c => !named.some(n => shortName(c).toLowerCase() === n.toLowerCase()));
        if (courseList.length !== n0) changed = true;
      } else { await reply('Stop which? e.g. "stop Sat", "stop Kennedy", "stop Kennedy Sat" or "stop all".'); continue; }
      const did = JSON.stringify(cfg.wants) !== before; changed = changed || did;
      await reply((did || changed ? 'Done. ' : 'Nothing matched that. ') + (cfg.wants.length ? 'Still watching:\n' + cfg.wants.map(w => '• ' + wantText(w)).join('\n') : 'Not watching any days now.'));
      continue;
    }
    if (/^(remove|drop)\s+course\b|^(add|use)\s+course\b/.test(t) && named.length && !dates.length) {   // edit the usual list explicitly
      if (/^(add|use)/.test(t)) for (const c of named) { if (!courseList.some(k => shortName(k).toLowerCase() === c.toLowerCase())) courseList.push(c); }
      else courseList = courseList.filter(c => !named.some(n => shortName(c).toLowerCase() === n.toLowerCase()));
      changed = true; await reply(`Your usual courses: ${general()}.`); continue;
    }

    if (!dates.length) {
      const bits = [named.length && 'at ' + named.join(', '), parseWindow(text) !== ALL_DAY && win(...parseWindow(text)), parsePlayers(text) && 'for ' + parsePlayers(text)].filter(Boolean);
      await reply(bits.length ? `Which day? I got ${bits.join(' ')} – add a day, e.g. "${text} Saturday".` : `I didn't catch that. ${HELP}`);
      continue;
    }
    const [from, to] = parseWindow(text);
    for (const date of dates) {
      const prev = cfg.wants.find(w => w.date === date && sameCourses(w.courses, named));
      const players = parsePlayers(text) || prev?.players || 2;
      // same day + same courses = an update (new times/players replace the old ones)
      cfg.wants = cfg.wants.filter(w => !(w.date === date && sameCourses(w.courses, named)));
      cfg.wants.push({ date, from, to, players, courses: named.length ? named : undefined });
    }
    cfg.wants.sort((a, b) => a.date.localeCompare(b.date) || a.from.localeCompare(b.from));
    changed = true;
    const got = cfg.wants.filter(w => dates.includes(w.date) && sameCourses(w.courses, named));
    const unknown = named.filter(n => !(fs.existsSync(COURSES) ? JSON.parse(fs.readFileSync(COURSES, 'utf8')) : []).some(c => shortName(c).toLowerCase() === n.toLowerCase()));
    await reply(`Got it – watching ${got.map(wantText).join(' and ')}${named.length ? '' : ` at your usual courses (${general()})`}.` +
      (unknown.length ? `\n⚠ I haven't seen tee times for ${unknown.join(', ')} in my booking sources yet – I'll alert if they show up, but they may not be bookable online here.` : '') +
      `\nI check every 5 minutes, 5 AM–10 PM, and post here the moment something opens. Say "list" to see everything, "stop ${nice(dates[0]).split(',')[0]}" to cancel.`);
  }
  fs.mkdirSync('state', { recursive: true });
  if (!TEXT) fs.writeFileSync(STATE, JSON.stringify(st));
  if (changed && gcal.ready) {
    const body = [...otherLines, ...courseList.map(c => 'COURSE: ' + c), ...cfg.wants.map(wantLine), 'GOLF-WATCH'].join('\n');
    if (golfEv) await gcal.patch(golfEv.id, { description: body }); else await gcal.insert({ summary: 'Personal: golf watch', description: body, when: new Date(), popup: null });
    console.log('calendar golf watch updated'); process.exit(3);
  }
  if (changed) { fs.writeFileSync(WANTS, JSON.stringify(cfg, null, 2) + '\n'); console.log('wants.json changed'); process.exit(3); }
  if (report) process.exit(4);
  console.log(`${msgs.length} message(s), no change.`);
})().catch(e => { console.error(e); process.exit(1); });
