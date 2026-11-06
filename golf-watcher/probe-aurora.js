// One-off: Aurora Golf (TeeItUp/Kenna) – list the per-course booking links and capture the tee-time API call + headers.
'use strict';
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  await page.goto('https://www.auroragov.org/things_to_do/golf/book_a_tee_time', { waitUntil: 'domcontentloaded', timeout: 40000 }); await sleep(5000);
  const links = await page.evaluate(() => [...document.querySelectorAll('a[href],iframe[src]')].map(a => ((a.innerText || a.title || '').trim().slice(0, 40)) + ' => ' + (a.href || a.src)).filter(h => !/auroragov\.org|civiclive|javascript:|mailto:|tel:|facebook|twitter|instagram|youtube|linkedin|nextdoor|x\.com/i.test(h.split(' => ')[1] || '')));
  console.log('external links on Book a Tee Time:\n  ' + [...new Set(links)].join('\n  '));
  const tee = [...new Set(links.map(l => l.split(' => ')[1]).filter(u => /teeitup|kenna|golfnow|foreup|chrono|book/i.test(u)))].slice(0, 6);
  for (const u of tee) {
    const calls = [];
    const onReq = r => { const x = r.url(); if (/kenna\.io|teeitup|tee-times|teetimes/i.test(x) && !/\.(js|css|png|svg|woff2?)(\?|$)/.test(x)) calls.push({ r, x }); };
    page.on('request', onReq);
    try { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 }); await sleep(12000); } catch (e) { console.log('ERR', u, e.message.split('\n')[0]); }
    page.off('request', onReq);
    console.log(`\n=== ${u} -> ${page.url()}`);
    for (const { r, x } of calls.slice(0, 15)) {
      const h = r.headers(); const keep = Object.fromEntries(Object.entries(h).filter(([k]) => /alias|x-|authorization|api|origin/i.test(k)));
      let body = ''; try { const resp = await r.response(); body = resp ? (await resp.text()).slice(0, 400).replace(/\s+/g, ' ') : ''; } catch {}
      console.log(`${r.method()} ${x.slice(0, 220)}\n   headers ${JSON.stringify(keep)}\n   -> ${body}`);
    }
  }
  await browser.close();
})();
