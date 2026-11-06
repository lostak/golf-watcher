// Google Calendar access for GitHub Actions, with a service account (no npm deps).
// Secrets: GCAL_SA_KEY = the service account's JSON key (whole file), GCAL_CALENDAR_ID = the calendar to use
// (Bradley's Gmail address). The calendar must be shared with the service account's email ("Make changes to events").
// Bradley's calendar is the one source of truth that the My Life app (web/Android/desktop), the Pocket processor,
// the Claude tasks, Discord and these watchers all read and write; this module is copied into each watcher repo.
'use strict';
const crypto = require('crypto');
const TZ = 'America/Denver';
let key = null;
try { key = process.env.GCAL_SA_KEY ? JSON.parse(process.env.GCAL_SA_KEY) : null; } catch { key = null; }
const CAL = process.env.GCAL_CALENDAR_ID;
const ready = !!(key && key.client_email && key.private_key && CAL);
let token = null, tokenExp = 0;

async function accessToken() {
  if (token && Date.now() < tokenExp - 60e3) return token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/calendar', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}` });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Google token: ' + (j.error_description || j.error || r.status));
  token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
  return token;
}
async function api(method, path, body, query) {
  const t = await accessToken();
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}${path}${qs}`, { method, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendar ${method} ${path}: ${r.status} ${(j.error && j.error.message) || ''}`);
  return j;
}
const iso = d => d.toISOString();
const daysAgo = n => new Date(Date.now() - n * 864e5);
const daysAhead = n => new Date(Date.now() + n * 864e5);

/** Events matching a free-text query in a time window (newest first). */
async function search(q, { back = 365, ahead = 2, max = 50 } = {}) {
  const j = await api('GET', '/events', null, { q, timeMin: iso(daysAgo(back)), timeMax: iso(daysAhead(ahead)), singleEvents: true, orderBy: 'startTime', maxResults: max });
  return (j.items || []).reverse();
}
/** The newest event whose title matches `title` (string or RegExp). */
async function findByTitle(title, q, opts) {
  const re = title instanceof RegExp ? title : new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  return (await search(q || String(title).replace(/^\^|\$$/g, ''), opts)).find(e => re.test(e.summary || '')) || null;
}
const get = id => api('GET', `/events/${encodeURIComponent(id)}`);
const patch = (id, body) => api('PATCH', `/events/${encodeURIComponent(id)}`, body);
/** Create a short event. `when` = Date; silent events pass popup = null. */
async function insert({ summary, description, when, minutes = 15, popup = 0, location }) {
  const start = when || new Date(), end = new Date(start.getTime() + minutes * 60e3);
  return api('POST', '/events', {
    summary, description, location,
    start: { dateTime: iso(start), timeZone: TZ }, end: { dateTime: iso(end), timeZone: TZ },
    reminders: popup === null ? { useDefault: false, overrides: [] } : { useDefault: false, overrides: [{ method: 'popup', minutes: popup }] },
  });
}
/** Next quarter hour from now (Date). */
function nextQuarter() { const d = new Date(); d.setSeconds(0, 0); d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15); return d; }
/** Replace the lines matching `re` in a description with `lines` (array), keeping everything else and the end marker last. */
function replaceLines(description, re, lines, marker) {
  const keep = String(description || '').split('\n').filter(l => !re.test(l) && l.trim() !== marker);
  return [...keep, ...lines, marker].filter(l => l !== undefined).join('\n');
}
/** Get or create a silent "log" event by exact title. */
async function ensureSilent(title, firstLines, marker) {
  const ev = await findByTitle(title, title.replace(/^Personal: /, ''), { back: 730 });
  if (ev) return ev;
  return insert({ summary: title, description: [...firstLines, marker].join('\n'), when: new Date(), popup: null });
}
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const nowLocal = () => new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

module.exports = { ready, search, findByTitle, get, patch, insert, nextQuarter, replaceLines, ensureSilent, todayLocal, nowLocal, TZ };
