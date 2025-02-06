import fs from 'fs';
import JSONBig from 'json-bigint';

// const originalFile = './packed/GeneralLockitSpanish-CAB-d60e2740a0d8c8bcedcc6e25a73023dc--3226765757514329824.json';
const originalFile = './packed/DialoguesLockitSpanish-CAB-d60e2740a0d8c8bcedcc6e25a73023dc--7891955455278724077.json';
// const translationsFile = './general/general-translated.json';
const translationsFile = './dialogues/dialogues-translated.json';

async function packTranslations() {
  const translations = JSONBig.parse(fs.readFileSync(translationsFile, 'utf8'));
  const original = JSONBig.parse(fs.readFileSync(originalFile, 'utf8'));

  let skippedTranslations = [];

  for (let i = 0; i < original.mSource.mTerms.Array.length; i++) {
    const term = original.mSource.mTerms.Array[i];
    const index = term.Term;

    if (!translations[index]) {
      skippedTranslations.push({ index, text: term.Languages.Array[0] });
      continue;
    }

    original.mSource.mTerms.Array[i].Languages.Array[0] = translations[index].belarusian;
  }

  fs.writeFileSync(originalFile, JSONBig.stringify(original, null, 2));

  if (skippedTranslations.length) {
    console.log('Skipped translations:');
    console.log(skippedTranslations);
    console.log('Total skipped:', skippedTranslations.length)
  }
}

packTranslations().then(() => console.log('Done'));