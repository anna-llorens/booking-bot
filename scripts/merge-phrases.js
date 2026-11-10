// merge-phrases.js — Adds new phrases (one JSON object per line) to test/fixtures/phrases.json without duplicates.
// Usage: node scripts/merge-phrases.js new-phrases.txt
const fs = require('fs');
const path = require('path');

const BANK = path.join(__dirname, '..', 'test', 'fixtures', 'phrases.json');
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/merge-phrases.js new-phrases.txt');
  process.exit(1);
}

let lines = fs.readFileSync(file, 'utf8').split('\n')
  .filter(l => l.includes('"text"'))
  .map(l => l.trim().replace(/,$/, ''));
lines = lines.map(l => l.startsWith('{') ? l : '{ ' + l);
const incoming = lines.map((l, i) => {
  try { return JSON.parse(l); } catch { console.error('Line', i + 1, 'is invalid:', l); return null; }
}).filter(Boolean);

// Entries without a label yet ("expected": {}) are skipped; "count" is only for the log.
const unlabeled = incoming.filter(p => !p.expected || !Object.keys(p.expected).length);
// Only phrase-bank fields are kept ("count", "business"… are only for the log)
const FIELDS = ['text', 'expected', 'today', 'context', 'source', 'note'];
const labeled = incoming.filter(p => !unlabeled.includes(p))
  .map(p => Object.fromEntries(FIELDS.filter(k => p[k] !== undefined).map(k => [k, p[k]])));
if (unlabeled.length) console.log('Skipped', unlabeled.length, 'phrases with an empty "expected"');

const db = JSON.parse(fs.readFileSync(BANK, 'utf8'));
const key = p => p.text + '|' + (p.today || '');
const existing = new Set(db.phrases.map(key));
const added = labeled.filter(p => !existing.has(key(p)));
db.phrases.push(...added);

fs.writeFileSync(BANK, `{\n  "_info": ${JSON.stringify(db._info)},\n  "today": "${db.today}",\n  "phrases": [\n${db.phrases.map(p => '    ' + JSON.stringify(p)).join(',\n')}\n  ]\n}\n`);
console.log('Read', incoming.length, '| added', added.length, '| total', db.phrases.length);
