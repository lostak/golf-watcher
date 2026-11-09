// Watchdog: DMs Bradley on Discord when another watcher's 5-minute loop stops (no run for 20+ minutes between
// 6 AM and 10 PM Denver), and again when it's back. With --slate (game-price-watcher only, it has the calendar) it also
// checks that the Claude betting-slate task posted today's slate by 7:10 AM.
// Usage: node watchdog.js "owner/repo:workflow.yml,owner/repo:workflow.yml" [--slate]
// Env: GH_API_TOKEN, DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID (any channel in the server), optional DISCORD_OWNER_ID.
// Copied into golf-watcher (which watches game-price-watcher), so the two cover each other.
'use strict';
const fs = require('fs');
const one = v => String(v || '').split(/\s+/).filter(Boolean)[0] || '';
const TOKEN = one(process.env.DISCORD_BOT_TOKEN), CHANNEL = one(process.env.DISCORD_CHANNEL_ID), GH = process.env.GH_API_TOKEN || process.env.GITHUB_TOKEN;
const STATE = 'state/watchdog.json', TZ = 'America/Denver';
const targets = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean).map(s => { const [repo, wf] = s.split(':'); return { repo, wf }; });
const hm = () => +new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).replace(':', '');

const dapi = async (method, path, body) => {
  const r = await fetch('https://discord.com/api/v10' + path, { method, headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Discord ${path} ${r.status}`); return r.json();
};
async function dm(st, text) {
  if (!st.dmId) {
    let owner = one(process.env.DISCORD_OWNER_ID);
    if (!owner) { const ch = await dapi('GET', `/channels/${CHANNEL}`); owner = (await dapi('GET', `/guilds/${ch.guild_id}`)).owner_id; }
    st.dmId = (await dapi('POST', '/users/@me/channels', { recipient_id: owner })).id;
  }
  await dapi('POST', `/channels/${st.dmId}/messages`, { content: text, allowed_mentions: { parse: [] } });
}

(async () => {
  if (!TOKEN || !CHANNEL) { console.log('watchdog: Discord bot not configured'); return; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  st.down ||= {};
  const t = hm(), daytime = t >= 600 && t < 2200;
  for (const { repo, wf } of targets) {
    const key = `${repo}:${wf}`;
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/runs?per_page=1`, { headers: { Accept: 'application/vnd.github+json', ...(GH ? { Authorization: 'Bearer ' + GH } : {}) } });
    if (!r.ok) { console.log(`watchdog: ${key} → GitHub ${r.status}`); continue; }
    const run = (await r.json()).workflow_runs?.[0];
    const age = run ? (Date.now() - Date.parse(run.created_at)) / 60e3 : Infinity;
    const name = repo.split('/')[1];
    if (age > 20 && daytime && !st.down[key]) {
      st.down[key] = new Date().toISOString();
      await dm(st, `⚠ **${name} stopped** – no run for ${Math.round(age)} minutes. It usually restarts itself within the hour; if not, open https://github.com/${repo}/actions and run "${wf.replace('.yml', '')}" (Run workflow).`);
      console.log('watchdog: alerted', key);
    } else if (age <= 20 && st.down[key]) {
      delete st.down[key];
      await dm(st, `✅ **${name} is running again.**`);
      console.log('watchdog: recovered', key);
    } else console.log(`watchdog: ${key} last run ${Math.round(age)} min ago`);
  }
  // the Claude betting-slate task should have posted today's slate by 7:10 AM
  if (process.argv.includes('--slate') && t >= 710 && t < 1100) {
    const cal = require('./gcal'), today = cal.todayLocal();
    if (cal.ready && st.slateChecked !== today) {
      const label = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
      const ev = await cal.findByTitle(new RegExp(`^Personal: betting slate – ${label}$`, 'i'), 'betting slate', { back: 1, ahead: 1 });
      if (!ev) await dm(st, `⚠ **No betting slate today** – the Claude "Betting slate & picks" task didn't post by 7:10 AM, so no picks went to #general. It may have hit a usage limit; you can rerun it by saying "personal run betting slate".`);
      st.slateChecked = today;
    }
  }
  fs.mkdirSync('state', { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(st));
})().catch(e => { console.error('watchdog:', e.message); process.exit(1); });
