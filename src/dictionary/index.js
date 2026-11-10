// dictionary — Tells whether a (normalized) word exists, to spot made-up text like "oeoe" or "asdf qwer".
//
// Words come from:
//   - words-es.txt.gz: every form of the Spanish dictionary from the RLA-ES project (LibreOffice),
//     expanded with scripts/build-dictionary.js. MPL 1.1, see LICENSE-MPL-1.1.txt and README.md.
//   - extra-words.txt: WhatsApp slang and salon vocabulary the dictionary doesn't have.
//   - the catalog synonyms and the engine's abbreviation list.
// Loaded on first use (~0.2 s, ~600k words).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let words = null;

function load() {
  const { normalize, REPLACEMENTS } = require('../understand');
  words = new Set(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'words-es.txt.gz'))).toString('utf8').split('\n'));
  const extra = fs.readFileSync(path.join(__dirname, 'extra-words.txt'), 'utf8').split('\n')
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const catalog = require('../catalog.json').services.flatMap(s => s.synonyms);
  for (const w of [...extra, ...catalog, ...Object.keys(REPLACEMENTS)].flatMap(x => normalize(x).split(' '))) words.add(w);
  words.delete('');
  return words;
}

// Diminutives the dictionary doesn't list: "huequito" -> "hueco", "ratito" -> "rato", "momentin" -> "momento"
function diminutiveBase(w) {
  const m = w.match(/^(.+?)(qu|gu|c)?(it|ill|in)(o|a|os|as)?$/);
  if (!m || m[1].length < 2) return [];
  const stem = m[1] + ({ qu: 'c', gu: 'g', c: '' }[m[2]] ?? '');
  return [stem + 'o', stem + 'a', stem + 'e', stem, stem + 'os', stem + 'as'];
}

// "jaja", "jajajja", "jejej", "jsjsjs": laughs, typos included
const isLaugh = w => /^(?=(?:.*j){2})(?=.*[aeiou])[jaeious]{4,}$/.test(w) || /^(ha){2,}h?$/.test(w);

function isKnownWord(w) {
  if (!words) load();
  if (words.has(w) || /^\d+$/.test(w)) return true;
  if (w.length <= 2) return true; // "a", "y", "xd", "ok": too short to judge
  if (isLaugh(w)) return true;
  return diminutiveBase(w).some(b => words.has(b));
}

// True when none of the words (3+ letters) exist: "oeoe", "asdf qwer", "jkjkjk".
// A message with at least one real word ("balayage rubio", "con que nombre me tienes") is not nonsense.
function isNonsense(normalizedText) {
  const candidates = normalizedText.split(/[^a-z]+/).filter(w => w.length >= 3); // "jfs'd" -> jfs, d
  return candidates.length > 0 && candidates.every(w => !isKnownWord(w));
}

// Only the Spanish dictionary itself (not the salon/WhatsApp extras), for typo checks in understand.js
let spanish = null;
function isSpanishWord(w) {
  if (!spanish) spanish = new Set(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'words-es.txt.gz'))).toString('utf8').split('\n'));
  return spanish.has(w);
}

module.exports = { isKnownWord, isNonsense, isLaugh, isSpanishWord };
