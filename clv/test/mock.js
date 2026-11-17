// Test-only: replaces fetch with canned Odds API / ESPN answers from the file in CLV_MOCK, and logs every call to CLV_MOCK + '.log'.
'use strict';
const fs = require('fs');
const F = process.env.CLV_MOCK;
global.fetch = async (url) => {
  const fx = JSON.parse(fs.readFileSync(F, 'utf8')), u = new URL(url);
  fs.appendFileSync(F + '.log', u.host + u.pathname + '?' + [...u.searchParams].filter(([k]) => k !== 'apiKey').map(([k, v]) => k + '=' + v).join('&') + '\n');
  const res = (status, body) => ({ ok: status < 400, status, headers: new Map([['x-requests-remaining', String(fx.remaining ?? 480)], ['x-requests-used', '20'], ['x-requests-last', '1']]), json: async () => body, text: async () => JSON.stringify(body) });
  if (u.host === 'api.the-odds-api.com') {
    if (fx.oddsDown) return res(500, { message: 'down' });
    const m = u.pathname.match(/sports\/([^/]+)\/(events|odds)(?:\/([^/]+)\/odds)?/);
    if (m[2] === 'events' && m[3]) return res(200, fx.eventOdds?.[m[3]] || {});
    if (m[2] === 'events') return res(200, (fx.events[m[1]] || []));
    const ids = (u.searchParams.get('eventIds') || '').split(',');
    if (u.searchParams.get('bookmakers').split(',').length > 10) return res(422, { message: 'too many books' });
    return res(200, (fx.odds[m[1]] || []).filter(e => ids.includes(e.id)));
  }
  if (u.host === 'site.api.espn.com') {
    if (fx.espnDown) return res(503, {});
    const lg = u.pathname.split('/sports/')[1].split('/scoreboard')[0];
    return res(200, { events: fx.espn[lg] || [] });
  }
  return res(404, {});
};
