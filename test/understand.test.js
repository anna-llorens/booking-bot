// understand.test.js — Measures how many phrases understand.js gets right.
//
//   Bank    (test/fixtures/phrases.json): phrases the rules are tuned on. Every one must pass: a failure fails the build.
//   Holdout (test/fixtures/holdout.json): phrases the rules are NOT tuned on (never write rules looking at them).
//            Informative only: it is the honest number for "how well does it understand new messages".
//
// Usage: npm test                            (summary + failures)
//        node test/understand.test.js --all  (also prints the ones it gets right)
const { understand } = require('../src/understand');
const bank = require('./fixtures/phrases.json');
const holdout = require('./fixtures/holdout.json');

const showAll = process.argv.includes('--all');
const fmt = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;

function run({ today, phrases }) {
  const reference = new Date(today);
  const results = phrases.map(({ text, expected, source = 'unknown', today: phraseToday, context }) => {
    const r = understand(text, { today: phraseToday ? new Date(phraseToday) : reference, context });
    const actual = { ...r, date: fmt(r.date) };
    const errors = Object.keys(expected).filter(k => JSON.stringify(actual[k] ?? null) !== JSON.stringify(expected[k]))
      .map(k => `${k}: expected ${JSON.stringify(expected[k])}, got ${JSON.stringify(actual[k] ?? null)}`);
    return { text, source, errors };
  });
  return { results, ok: results.filter(r => !r.errors.length).length, total: results.length };
}

function print(results) {
  for (const r of results) {
    if (!r.errors.length) { if (showAll) console.log(`✓ ${r.text}`); continue; }
    console.log(`✗ ${r.text}`);
    r.errors.forEach(e => console.log(`    ${e}`));
  }
}

// Bank
const b = run(bank);
print(b.results);
const bySource = {};
for (const r of b.results) {
  bySource[r.source] = bySource[r.source] ?? { ok: 0, total: 0 };
  bySource[r.source].total++;
  if (!r.errors.length) bySource[r.source].ok++;
}
console.log(`\nBank: ${b.ok}/${b.total} (${(b.ok / b.total * 100).toFixed(1)} %)`);
console.log('By source:', Object.entries(bySource).map(([s, c]) => `${s} ${c.ok}/${c.total}`).join(', '));

// Holdout (informative)
const h = run(holdout);
if (h.total) {
  console.log(`\nHoldout (not tuned on, informative): ${h.ok}/${h.total} (${(h.ok / h.total * 100).toFixed(1)} %)`);
  print(h.results);
}

process.exitCode = b.ok === b.total ? 0 : 1;
