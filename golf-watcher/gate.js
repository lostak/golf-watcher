// Prints the number of upcoming wanted days (calendar + wants.json, which the Tee Watch app edits). Used by the workflow gate.
'use strict';
const fs = require('fs');
const gcal = require('./gcal');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
(async () => {
  let wants = (JSON.parse(fs.readFileSync('wants.json', 'utf8')).wants || []);
  if (gcal.ready) {
    try { const ev = await gcal.findByTitle('Personal: golf watch', 'golf watch'); wants = wants.concat(ev ? [...(ev.description || '').matchAll(/^\s*WANT:\s*(\d{4}-\d{2}-\d{2})/gm)].map(m => ({ date: m[1] })) : []); }
    catch (e) { console.error('calendar: ' + e.message.slice(0, 100)); }
  }
  console.log(wants.filter(w => w.date >= today).length);
})();
