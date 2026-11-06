// One-off: find Aurora Golf's booking engine and its tee-time API. Read-only.
'use strict';
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  const seen = [];
  ctx.on('response', async r => {
    const u = r.url(); if (/\.(js|css|png|jpe?g|svg|gif|woff2?|ico|webp)(\?|$)/i.test(u) || /google|facebook|doubleclick|analytics|hotjar|clarity|cookie|onetrust|sentry|newrelic/i.test(u)) return;
    let t = ''; try { const ct = r.headers()['content-type'] || ''; if (/json/.test(ct)) t = (await r.text()).slice(0, 300).replace(/\s+/g, ' '); } catch {}
    seen.push(`${r.status()} ${r.request().method()} ${u.slice(0, 180)}${t ? '\n      -> ' + t : ''}`);
  });
  const page = await ctx.newPage();
  for (const url of ['https://www.golfaurora.com/', 'https://www.auroragov.org/things_to_do/recreation___sports_programs/golf']) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }); await sleep(5000);
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href],iframe[src]')].map(a => (a.innerText || '').trim().slice(0, 30) + ' => ' + (a.href || a.src)).filter(h => /tee|book|reserv/i.test(h)));
      console.log(`\n=== ${url} (${await page.title()})\nbooking links:\n  ` + [...new Set(links)].slice(0, 20).join('\n  '));
    } catch (e) { console.log('ERR', url, e.message.split('\n')[0]); }
  }
  // follow the first booking link(s)
  const links = [...new Set(await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /tee|book/i.test(h) && !/mailto|tel:/.test(h))))].slice(0, 3);
  for (const l of links) {
    seen.length = 0;
    try { await page.goto(l, { waitUntil: 'domcontentloaded', timeout: 40000 }); await sleep(12000); console.log(`\n=== followed ${l} -> ${page.url()} (${await page.title()})`); console.log(seen.slice(0, 40).join('\n')); }
    catch (e) { console.log('ERR follow', l, e.message.split('\n')[0]); }
  }
  await browser.close();
})();
