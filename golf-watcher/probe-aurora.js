// One-off: capture EZLinks (City of Aurora) search API calls, request bodies and responses.
'use strict';
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  const log = [];
  page.on('response', async r => {
    const u = r.url(); if (!/ezlinks/i.test(u) || /\.(js|css|png|jpe?g|svg|gif|woff2?|html?)(\?|$)/i.test(u)) return;
    let body = ''; try { body = (await r.text()).slice(0, 700).replace(/\s+/g, ' '); } catch {}
    log.push(`${r.status()} ${r.request().method()} ${u}\n   req: ${(r.request().postData() || '').slice(0, 400)}\n   -> ${body}`);
  });
  await page.goto('https://cityofaurora.ezlinksgolf.com/index.html#!/search', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(15000);
  console.log('title:', await page.title(), '| url:', page.url());
  console.log(log.join('\n'));
  console.log('\npage text:', (await page.evaluate(() => document.body.innerText)).slice(0, 1200).replace(/\n+/g, ' | '));
  await browser.close();
})();
