// Probe for the standalone phone app: capture each tee-sheet site's own API call in a browser, print it (cookies
// redacted), then replay it with plain HTTP (no browser, no cookies) the way an Android app would. Manual only.
'use strict';
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const D = new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
const gnDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).replace(',', '').replace(/ /g, '+');
const PAGES = [
  ['golfnow-area', `https://www.golfnow.com/tee-times/search#facilitytype=GolfCourse&date=${gnDate(D)}&longitude=-104.8319&latitude=39.7294&radius=30&players=2&sortby=Facilities.Distance.0`, /golfnow\.com\/api\//i],
  ['golfnow-facility', `https://www.golfnow.com/tee-times/facility/17877-saddle-rock-golf-course/search#date=${gnDate(D)}&players=2`, /golfnow\.com\/api\//i],
  ['chronogolf-club', `https://www.chronogolf.com/club/south-suburban-golf-club?date=${D}`, /chronogolf\.com\/(marketplace|api)/i],
  ['chronogolf-search', `https://www.chronogolf.com/en/search?latitude=39.7294&longitude=-104.8319`, /chronogolf\.com\/(marketplace|api)/i],
  ['membersports', 'https://app.membersports.com/tee-times/3629/20573/1/1/0', /api\.membersports\.com/i],
];
const red = h => Object.fromEntries(Object.entries(h).filter(([k]) => !/^(cookie|content-length|sec-|accept-encoding|connection|host)/i.test(k)));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  for (const [name, url, re] of PAGES) {
    console.log(`\n===== ${name}: ${url}`);
    const ctx = await browser.newContext({ userAgent: UA }), p = await ctx.newPage(), calls = [];
    p.on('response', async r => {
      const q = r.request(); if (!re.test(q.url()) || q.resourceType() === 'document') return;
      let t = ''; try { t = await r.text(); } catch {}
      calls.push({ m: q.method(), u: q.url(), h: red(q.headers()), b: q.postData(), s: r.status(), t });
    });
    try { await p.goto(url, { waitUntil: 'networkidle', timeout: 60000 }); } catch (e) { console.log('goto: ' + e.message.split('\n')[0]); }
    await p.waitForTimeout(6000);
    for (const c of calls.filter(c => /courses-near-me|tee-time-search-results|onlineBookingTeeTimes|teetimes\?/i.test(c.u)).slice(0, 4)) {
      console.log(`--- ${c.m} ${c.u.slice(0, 260)} → ${c.s} (${c.t.length}b)`);
      console.log('    headers ' + JSON.stringify(c.h).slice(0, 700));
      if (c.b) console.log('    body ' + c.b.slice(0, 2000));
      console.log('    resp ' + c.t.slice(0, 3500).replace(/\s+/g, ' '));
      // plain HTTP replay: browser headers minus cookies, then a minimal set
      for (const [label, headers] of [['replay', c.h], ['minimal', { 'User-Agent': UA, Accept: 'application/json', ...(c.b ? { 'Content-Type': c.h['content-type'] || 'application/json' } : {}), ...Object.fromEntries(Object.entries(c.h).filter(([k]) => /^x-|authorization|api-?key/i.test(k))) }]]) {
        try { const r = await fetch(c.u, { method: c.m, headers, body: c.b || undefined }); const t = await r.text();
          console.log(`    ${label}: ${r.status} ${t.length}b same=${t.length > 50 && Math.abs(t.length - c.t.length) < c.t.length * 0.3} ${t.slice(0, 120).replace(/\s+/g, ' ')}`);
        } catch (e) { console.log(`    ${label}: error ${e.message}`); }
      }
    }
    if (!calls.length) console.log('(no matching API calls)'); else console.log(`(${calls.length} calls total: ${[...new Set(calls.map(c => c.m + ' ' + c.u.split('?')[0]))].slice(0, 12).join(' | ')})`);
    await ctx.close();
  }
  await browser.close();
})();
