import fs from 'fs';

const middleTranslationFile = './../../../text/translated/dialogues-translated.json';
const extractedDialogueTree = './../../../text/dialogues-tree-english.json';
const dialoguesFolder = './../../../text/dialogues'; // TODO: Check dialogues tree for integrity

const getTranslationsFromTreeRecursively = (links, result) => {
  for (const link of links) {
    result[link.articyId] = link.english;
    getTranslationsFromTreeRecursively(link.links, result);
  }

  return result;
}

async function checkIntegrityMiddleAndExtracted() {
  const translations = JSON.parse(fs.readFileSync(middleTranslationFile, 'utf8'));
  const extracted = JSON.parse(fs.readFileSync(extractedDialogueTree, 'utf8'));

  const extractedKeys = Object.keys(extracted);

  let counter = 0;

  for (const key of extractedKeys) {
    if (!translations[`Dialogue Text/${key}`]) {
      console.log('Missing in translations:', key);
      counter++;
    }
  }

  console.log('Missing in translations:', counter);

}

checkIntegrityMiddleAndExtracted().then(() => console.log('Done'));