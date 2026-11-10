// build-dictionary.js — Expands a Hunspell dictionary (.dic + .aff) into a plain list of every word form,
// normalized like the engine does (lowercase, no accents, ñ -> n), one per line.
//
// Usage: node scripts/build-dictionary.js es_ES.dic es_ES.aff > src/dictionary/words-es.txt
//
// Source used: the Spanish dictionary from the RLA-ES project as shipped by LibreOffice
// (https://github.com/LibreOffice/dictionaries/tree/master/es), licensed GPLv3+ / LGPLv3+ / MPL 1.1+;
// this repo uses it under MPL 1.1 (see src/dictionary/LICENSE-MPL-1.1.txt).
//
// Supports what that dictionary uses: UTF-8 single-character flags, SFX/PFX rules with conditions,
// one level of continuation classes ("ción/S") and prefix + suffix cross products.
const fs = require('fs');

const [dicFile, affFile] = process.argv.slice(2);
if (!dicFile || !affFile) {
  console.error('Usage: node scripts/build-dictionary.js file.dic file.aff > words.txt');
  process.exit(1);
}

const normalize = w => w.toLowerCase().replace(/ñ/g, 'n').normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---- parse .aff ----
const rules = {}; // flag -> { type: 'SFX'|'PFX', cross: bool, list: [{ strip, add, cont, cond }] }
for (const line of fs.readFileSync(affFile, 'utf8').split(/\r?\n/)) {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== 'SFX' && parts[0] !== 'PFX') continue;
  const [type, flag] = parts;
  if (parts.length === 4 && /^\d+$/.test(parts[3])) { // header: SFX S Y 31
    rules[flag] = { type, cross: parts[2] === 'Y', list: [] };
    continue;
  }
  const strip = parts[2] === '0' ? '' : parts[2];
  let [add, cont = ''] = parts[3].split('/');
  if (add === '0') add = '';
  const cond = parts[4] && parts[4] !== '.' ? parts[4] : null;
  const condRe = cond ? new RegExp(type === 'SFX' ? `${cond}$` : `^${cond}`) : null;
  rules[flag].list.push({ strip, add, cont: [...cont], condRe });
}

function applySuffix(word, rule) {
  if (rule.condRe && !rule.condRe.test(word)) return null;
  if (rule.strip && !word.endsWith(rule.strip)) return null;
  return word.slice(0, word.length - rule.strip.length) + rule.add;
}
function applyPrefix(word, rule) {
  if (rule.condRe && !rule.condRe.test(word)) return null;
  if (rule.strip && !word.startsWith(rule.strip)) return null;
  return rule.add + word.slice(rule.strip.length);
}

// ---- expand .dic ----
const out = new Set();
const add = w => { const n = normalize(w); if (/^[a-z]+$/.test(n)) out.add(n); };

const lines = fs.readFileSync(dicFile, 'utf8').split(/\r?\n/).slice(1); // first line = count
for (const line of lines) {
  if (!line.trim()) continue;
  const [word, flagStr = ''] = line.split('/');
  const flags = [...flagStr.trim()];
  add(word);

  const suffixed = []; // forms built with cross-product suffixes, for prefixes later
  for (const f of flags) {
    const r = rules[f];
    if (!r || r.type !== 'SFX') continue;
    for (const rule of r.list) {
      const form = applySuffix(word, rule);
      if (form === null) continue;
      add(form);
      if (r.cross) suffixed.push(form);
      for (const c of rule.cont) { // continuation: "ción/S" -> "ciones"
        const r2 = rules[c];
        if (!r2 || r2.type !== 'SFX') continue;
        for (const rule2 of r2.list) {
          const form2 = applySuffix(form, rule2);
          if (form2 !== null) add(form2);
        }
      }
    }
  }
  for (const f of flags) {
    const r = rules[f];
    if (!r || r.type !== 'PFX') continue;
    for (const rule of r.list) {
      for (const base of r.cross ? [word, ...suffixed] : [word]) {
        const form = applyPrefix(base, rule);
        if (form !== null) add(form);
      }
    }
  }
}

process.stdout.write([...out].sort().join('\n') + '\n');
console.error(`${out.size} word forms`);
