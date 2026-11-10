// import-whatsapp.js — Turns an exported WhatsApp chat (.txt) into phrases ready to label.
// Usage: node scripts/import-whatsapp.js chat.txt "Business name" [--dmy] > new-phrases.txt
//   - Keeps only the CUSTOMER's messages (everything not written by the business).
//   - Each phrase carries its own date ("today") so "mañana" or "el viernes" are computed correctly.
//   - --dmy if the phone exports dates as day/month/year (Spanish phones). Without it: month/day/year.
//   - Removes phone numbers and emails. Check names by hand before saving anything (GDPR).
// Then: fill in "expected" on each line and run  node scripts/merge-phrases.js new-phrases.txt
const fs = require('fs');

const [file, business, ...flags] = process.argv.slice(2);
if (!file || !business) {
  console.error('Usage: node scripts/import-whatsapp.js chat.txt "Business name" [--dmy]');
  process.exit(1);
}
const dmy = flags.includes('--dmy');

// [11/5/25, 10:25:27 AM] Name: text     or     11/5/25, 10:25 - Name: text
const HEADER = /^\[?(\d{1,2})\/(\d{1,2})\/(\d{2,4}),? (\d{1,2}):(\d{2})(?::\d{2})?\s?([AP]\.?\s?M\.?)?\]?\s?-?\s?([^:]+): (.*)$/i;

const messages = [];
for (const line of fs.readFileSync(file, 'utf8').replace(/‎/g, '').split(/\r?\n/)) {
  const m = line.match(HEADER);
  if (m) {
    const [, a, b, y, h, min, ampm, author, text] = m;
    const [day, month] = dmy ? [+a, +b] : [+b, +a];
    let hour = +h;
    if (ampm && /p/i.test(ampm) && hour < 12) hour += 12;
    if (ampm && /a/i.test(ampm) && hour === 12) hour = 0;
    const year = y.length === 2 ? 2000 + +y : +y;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${min}:00`;
    messages.push({ author: author.trim(), text, today: date });
  } else if (/^\[?\d{1,2}\/\d{1,2}\/\d{2,4},/.test(line)) {
    messages.push({ author: '- system', text: line, today: '' }); // calls, notices: discarded
  } else if (messages.length && line.trim()) {
    messages[messages.length - 1].text += ' ' + line.trim(); // multi-line message
  }
}

const anonymize = t => t
  .replace(/\+?\d[\d\s]{7,}\d/g, '[phone]')
  .replace(/\S+@\S+\.\S+/g, '[email]');

// WhatsApp system lines (Spanish export): omitted media, calls, images, encryption notice
const IGNORE = /omitid[oa]|^\[?(llamada|imagen|audio|video|sticker)|cifrados de extremo/i;

const output = messages
  .filter(m => !m.author.toLowerCase().includes(business.toLowerCase()))
  .filter(m => !IGNORE.test(m.text) && m.author !== '- system')
  .map(m => `{ "text": ${JSON.stringify(anonymize(m.text.trim()))}, "expected": {}, "today": "${m.today}", "source": "real" },`);

console.log(output.join('\n'));
console.error(`${output.length} customer messages (out of ${messages.length} in total)`);
