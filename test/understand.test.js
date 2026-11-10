// understand.test.js — Measures how many phrases understand.js gets right.
// Usage: npm test                          (summary + failures)
//        node test/understand.test.js --all (also prints the ones it gets right)
const { understand } = require('../src/understand');
const { today, phrases } = require('./fixtures/phrases.json');

const reference = new Date(today);
const showAll = process.argv.includes('--all');
const fmt = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

let ok = 0;
const failuresByField = {};
const failuresBySource = {};
const totalBySource = {};

for (const { text, expected, source = 'unknown', today: phraseToday, context } of phrases) {
  const r = understand(text, { today: phraseToday ? new Date(phraseToday) : reference, context });
  const actual = { ...r, date: fmt(r.date) };
  const errors = Object.keys(expected).filter(k => JSON.stringify(actual[k] ?? null) !== JSON.stringify(expected[k]));
  totalBySource[source] = (totalBySource[source] || 0) + 1;

  if (errors.length === 0) {
    ok++;
    if (showAll) console.log(`✓ ${text}`);
  } else {
    failuresBySource[source] = (failuresBySource[source] || 0) + 1;
    errors.forEach(k => failuresByField[k] = (failuresByField[k] || 0) + 1);
    console.log(`✗ ${text}`);
    errors.forEach(k => console.log(`    ${k}: expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(actual[k] ?? null)}`));
  }
}

const pct = (ok / phrases.length * 100).toFixed(1);
console.log(`\nAccuracy: ${ok}/${phrases.length} (${pct} %)`);
console.log('Failures by field:', failuresByField);
console.log('By source:');
for (const s of Object.keys(totalBySource)) {
  const f = failuresBySource[s] || 0;
  console.log(`  ${s}: ${totalBySource[s] - f}/${totalBySource[s]}`);
}

process.exitCode = phrases.length - ok ? 1 : 0;
