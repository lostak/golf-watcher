// One-off: (1) EZLinks in headed Chrome (Cloudflare challenge), (2) does GolfNow list the Aurora courses?
'use strict';
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  const log = [];
  page.on('response', async r => {
    const u = r.url(); if (!/ezlinks/i.test(u) || /cdn-cgi|\.(js|css|png|jpe?g|svg|gif|woff2?|html?)(\?|$)/i.test(u)) return;
    let body = ''; try { body = (await r.text()).slice(0, 600).replace(/\s+/g, ' '); } catch {}
    log.push(`${r.status()} ${r.request().method()} ${u}\n   req: ${(r.request().postData() || '').slice(0, 400)}\n   -> ${body}`);
  });
  await page.goto('https://cityofaurora.ezlinksgolf.com/index.html#!/search', { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 8 && /just a moment/i.test(await page.title()); i++) await sleep(5000);
  await sleep(10000);
  console.log('EZLinks title:', await page.title());
  console.log(log.slice(0, 20).join('\n'));
  console.log('page text:', (await page.evaluate(() => document.body.innerText)).slice(0, 800).replace(/\n+/g, ' | '));
  // GolfNow search for the Aurora courses
  for (const q of ['murphy creek', 'saddle rock', 'aurora hills', 'meadow hills', 'springhill']) {
    const p = await ctx.newPage(); const hits = [];
    p.on('response', async r => { const u = r.url(); if (/golfnow\.com\/api\/.*(search|facilit|autocomplete)/i.test(u)) { try { hits.push(u.slice(0, 160) + ' -> ' + (await r.text()).slice(0, 300).replace(/\s+/g, ' ')); } catch {} } });
    try { await p.goto('https://www.golfnow.com/tee-times/search#qc=GeoLocation&q=' + encodeURIComponent(q + ' aurora co'), { waitUntil: 'domcontentloaded', timeout: 40000 }); await sleep(6000);
      const links = [...new Set(await p.$$eval('a[href*="/tee-times/facility/"]', as => as.map(a => a.href)))].filter(h => h.toLowerCase().includes(q.split(' ')[0])).slice(0, 3);
      console.log(`GolfNow "${q}": ${links.join(' , ') || 'no facility link'}`); } catch (e) { console.log('GolfNow ERR', q, e.message.split('\n')[0]); }
    await p.close();
  }
  await browser.close();
})();
