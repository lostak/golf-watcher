// One-off discovery: opens each course's tee-time page and logs which booking engine it calls, plus
// Chronogolf's marketplace calls, so the watcher can be pointed at every course. Read-only.
const { chromium } = require('playwright');
const ENGINES = /foreup|teeitup|kenna\.io|chronogolf|lightspeed|golfnow|membersports|ezlinks|clubprophet|teesnap|golfback|quick18|cps\.golf|supremegolf|golfrev|cybergolf|teewire|golfgenius|club-caddie|clubcaddie|teeon|chelsea|totale|teequest|golfpass|teeoff/i;
const PAGES = [
  ['Fossil Trace', 'https://www.fossiltrace.com/'],
  ['Broken Tee (Englewood)', 'https://www.brokenteegolf.com/'],
  ['Buffalo Run', 'https://www.buffalorungolfcourse.com/'],
  ['Thorncreek', 'https://www.thorncreekgc.com/'],
  ['Legacy Ridge (Westminster)', 'https://www.legacyridgegc.com/'],
  ['Walnut Creek (Westminster)', 'https://www.walnutcreekgolf.com/'],
  ['Green Valley Ranch', 'https://www.gvrgolf.com/'],
  ['CommonGround', 'https://www.commongroundgc.com/'],
  ['Indian Tree (Arvada)', 'https://indiantree.apexprd.org/'],
  ['Coal Creek (Louisville)', 'https://www.coalcreekgolf.com/'],
  ['Raccoon Creek (Littleton)', 'https://www.raccooncreek.com/'],
  ['Red Hawk Ridge (Castle Rock)', 'https://www.redhawkridge.com/'],
  ['Applewood', 'https://www.applewoodgc.com/'],
  ['Bear Creek (Denver)', 'https://www.bearcreekgolf.com/'],
  ['Meadows (Littleton)', 'https://www.meadowsgolfclub.com/'],
  ['Homestead (Lakewood)', 'https://www.lakewood.org/Government/Departments/Community-Resources/Golf'],
  ['Hiwan/Evergreen area: Evergreen Golf', 'https://www.denvergov.org/Government/Agencies-Departments-Offices/Agencies-Departments-Offices-Directory/Parks-Recreation/Golf'],
  ['Saddle Rock', 'https://www.golfaurora.com/'],
  ['Hyland Hills', 'https://www.golfhylandhills.com/'],
  ['Broadlands', 'https://www.broadlandsgolf.com/'],
  ['Eagle Trace', 'https://www.eagletracegolf.com/'],
  ['Indian Peaks', 'https://www.indianpeaksgolf.com/'],
  ['Flatirons (Boulder)', 'https://www.flatironsgolf.com/'],
  ['Ute Creek (Longmont)', 'https://www.utecreekgolf.com/'],
  ['Twin Peaks (Longmont)', 'https://www.twinpeaksgolf.com/'],
  ['Mariana Butte (Loveland)', 'https://www.golfloveland.com/'],
  ['Heritage Eagle Bend', 'https://www.heritageeaglebend.com/'],
  ['Black Bear (Parker)', 'https://www.blackbeargolfclub.com/'],
  ['Bear Dance (Larkspur)', 'https://www.beardancegolf.com/'],
  ['Arrowhead (Littleton)', 'https://www.arrowheadcolorado.com/'],
];
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
  const ctx = await browser.newContext();
  for (const [name, url] of PAGES) {
    const p = await ctx.newPage(); const hits = new Set();
    p.on('request', r => { const u = r.url(); if (ENGINES.test(u)) hits.add(u.replace(/\?.*$/, '').slice(0, 110)); });
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(6000);
      const links = await p.evaluate(() => [...document.querySelectorAll('a[href],iframe[src]')].map(a => a.href || a.src).filter(h => /tee|book|reserv|chrono|foreup|golfnow|teeitup|membersports/i.test(h)).slice(0, 8));
      for (const l of links) if (ENGINES.test(l)) hits.add('link: ' + l.slice(0, 110));
      console.log(`${name}: ${[...hits].join(' | ') || 'no engine seen'}${links.length ? '\n   links: ' + links.map(l => l.slice(0, 90)).join(' , ') : ''}`);
    } catch (e) { console.log(`${name}: ERROR ${e.message.split('\n')[0].slice(0, 80)}`); }
    await p.close();
  }
  // Chronogolf marketplace: what the club page and a nearby-search call look like
  for (const url of ['https://www.chronogolf.com/club/south-suburban-golf-club?date=2026-11-07', 'https://www.chronogolf.com/en/search?latitude=39.7294&longitude=-104.8319', 'https://www.chronogolf.com/']) {
    const p = await ctx.newPage(); const calls = [];
    p.on('response', async r => { const u = r.url(); if (/chronogolf\.com\/(marketplace|api)|lightspeed/i.test(u) && !/\.(js|css|png|svg|woff)/.test(u)) { let t = ''; try { t = (await r.text()).slice(0, 500); } catch (e) {} calls.push(`${r.request().method()} ${u.slice(0, 200)}\n      -> ${t.replace(/\s+/g, ' ')}`); } });
    try { await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await p.waitForTimeout(8000); } catch (e) { console.log('ERROR', url, e.message.slice(0, 60)); }
    console.log(`\n=== ${url}\n` + (calls.slice(0, 25).join('\n') || '(no marketplace calls)'));
    await p.close();
  }
  await browser.close();
})();
