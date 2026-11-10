# Spanish word list

Used by `src/dictionary/index.js` to tell real words from made-up text ("oeoe", "asdf qwer").

- **`words-es.txt.gz`**: every word form (about 593,000) of the Spanish (Spain) Hunspell dictionary from the
  [RLA-ES project](https://github.com/sbosio/rla-es), as shipped by LibreOffice
  ([es_ES.dic / es_ES.aff](https://github.com/LibreOffice/dictionaries/tree/762abe74008b94b2ff06db6f4024b59a8254c467/es), commit `762abe74008b94b2ff06db6f4024b59a8254c467`).
  Expanded and normalized (lowercase, no accents, ñ → n) with `scripts/build-dictionary.js`.
- **License:** the dictionary is triple-licensed GPLv3+ / LGPLv3+ / MPL 1.1+. This project uses it under the
  **MPL 1.1** (`LICENSE-MPL-1.1.txt`). The word list is a modified form of the original files; the originals
  are available at the link above.
- **`extra-words.txt`**: WhatsApp slang and salon vocabulary the dictionary doesn't have. Add words here when
  a real word is treated as made-up.

## Rebuilding

```bash
curl -LO https://raw.githubusercontent.com/LibreOffice/dictionaries/master/es/es_ES.dic
curl -LO https://raw.githubusercontent.com/LibreOffice/dictionaries/master/es/es_ES.aff
node scripts/build-dictionary.js es_ES.dic es_ES.aff | gzip -9 > src/dictionary/words-es.txt.gz
```
