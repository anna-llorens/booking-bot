// merge-phrases.js — Adds new labeled phrases (one JSON object per line) to the phrase bank and the holdout.
//
// Usage: node scripts/merge-phrases.js new-phrases.txt [--holdout-share 0.2]
//
// A share of the new phrases (20 % by default) goes to test/fixtures/holdout.json instead of the bank,
// chosen by a hash of the text (scripts/holdout.js), never by hand. Holdout phrases are never used to tune rules.
// Phrases already in the bank or the holdout (same text and day) are skipped.
const fs = require('fs');
const path = require('path');
const { inHoldout } = require('./holdout');

const BANK = path.join(__dirname, '..', 'test', 'fixtures', 'phrases.json');
const HOLDOUT = path.join(__dirname, '..', 'test', 'fixtures', 'holdout.json');

const args = process.argv.slice(2);
const shareAt = args.indexOf('--holdout-share');
const shareArg = shareAt >= 0 ? Number(args[shareAt + 1]) : 0.2;
const file = args.find((a, i) => !a.startsWith('--') && (shareAt < 0 || i !== shareAt + 1));
if (!file || Number.isNaN(shareArg) || shareArg < 0 || shareArg > 1) {
  console.error('Usage: node scripts/merge-phrases.js new-phrases.txt [--holdout-share 0.2]');
  process.exit(1);
}

let lines = fs.readFileSync(file, 'utf8').split('\n')
  .filter(l => l.includes('"text"'))
  .map(l => l.trim().replace(/,$/, ''));
lines = lines.map(l => l.startsWith('{') ? l : '{ ' + l);
const incoming = lines.map((l, i) => {
  try { return JSON.parse(l); } catch { console.error('Line', i + 1, 'is invalid:', l); return null; }
}).filter(Boolean);

// Entries without a label yet ("expected": {}) are skipped. Only phrase-bank fields are kept
// ("count", "business"… are only for the not-understood log).
const unlabeled = incoming.filter(p => !p.expected || !Object.keys(p.expected).length);
const FIELDS = ['text', 'expected', 'today', 'context', 'source', 'note'];
const labeled = incoming.filter(p => !unlabeled.includes(p))
  .map(p => Object.fromEntries(FIELDS.filter(k => p[k] !== undefined).map(k => [k, p[k]])));
if (unlabeled.length) console.log('Skipped', unlabeled.length, 'phrases with an empty "expected"');

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, db) => fs.writeFileSync(f, `{\n  "_info": ${JSON.stringify(db._info)},\n  "today": "${db.today}",\n  "phrases": [\n${db.phrases.map(p => '    ' + JSON.stringify(p)).join(',\n')}\n  ]\n}\n`);
const bank = read(BANK);
const holdout = read(HOLDOUT);
const key = p => p.text + '|' + (p.today || '');
const existing = new Set([...bank.phrases, ...holdout.phrases].map(key));

const added = labeled.filter(p => !existing.has(key(p)));
const toHoldout = added.filter(p => inHoldout(p.text, shareArg));
const toBank = added.filter(p => !toHoldout.includes(p));
bank.phrases.push(...toBank);
holdout.phrases.push(...toHoldout);
write(BANK, bank);
write(HOLDOUT, holdout);
console.log('Read', incoming.length, '| added', toBank.length, 'to the bank and', toHoldout.length,
  'to the holdout | totals: bank', bank.phrases.length, ', holdout', holdout.phrases.length);
if (toHoldout.length) console.log('Holdout phrases are not for tuning rules: don\'t look at them to write rules.');
