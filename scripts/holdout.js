// holdout.js — Deterministic split between the phrase bank and the holdout set.
//
// A phrase goes to the holdout when the hash of its text falls under `share` (0.2 = 20 %). The same text
// always lands on the same side, so the split never depends on who runs it or on the order of the files.
//
// The holdout measures the engine on phrases its rules were NOT written for. Rule: holdout phrases are
// never used to tune rules (see README "Improving it"). If a general rule happens to fix one, fine.

// 32-bit FNV-1a hash of the text
function hash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const inHoldout = (text, share = 0.2) => hash(text) % 1000 < Math.round(share * 1000);

module.exports = { hash, inHoldout };
