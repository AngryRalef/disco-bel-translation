import fs from 'fs';
import JSONBig from 'json-bigint';

const dialoguesTreeFolder = './../../../text/dialogues';
const flatDialoguesFilePath = './../../../text/translated/dialogues-translated.json';

const generalFilesFolder = './../../../text/general';
const generalTranslatedFilePath = './../../../text/translated/general-translated.json';

const files = [
  {
    packed: './../../../text/translated/GeneralLockitSpanish-CAB-d60e2740a0d8c8bcedcc6e25a73023dc--3226765757514329824.json',
    unpacked: './../../../text/translated/general-translated.json'
  },
  {
    packed: './../../../text/translated/DialoguesLockitSpanish-CAB-d60e2740a0d8c8bcedcc6e25a73023dc--7891955455278724077.json',
    unpacked: './../../../text/translated/dialogues-translated.json'
  }
]

async function packDialoguesFromTreesToSingleFile() {
  function getTranslationsFromTreeRecursively(links, result) {
    for (const link of links) {
      result[link.articyId] = link.belarusian;
      getTranslationsFromTreeRecursively(link.links, result);
    }

    return result;
  }

  const filesPaths = fs.readdirSync(dialoguesTreeFolder);

  const flatDialogues = JSONBig.parse(fs.readFileSync(flatDialoguesFilePath, 'utf8'));

  let translations = {};

  let totalRowsInTrees = 0;

  for (const file of filesPaths) {
    const dialogues = JSONBig.parse(fs.readFileSync(dialoguesTreeFolder + '/' + file, 'utf8'));

    const flattenedDialogueTree = getTranslationsFromTreeRecursively(dialogues.dialogueTree, translations);
    totalRowsInTrees += Object.keys(flattenedDialogueTree).length;

    translations = { ...translations, ...flattenedDialogueTree };
  }

  let notFound = 0;

  for (const key in translations) {
    if (!flatDialogues[`Dialogue Text/${key}`]) {
      console.log(`Can't find in dialogues-translated.json key: ${key}`);
      notFound++;
      continue;
    }

    flatDialogues[`Dialogue Text/${key}`].belarusian = translations[key];
  }

  fs.writeFileSync(flatDialoguesFilePath, JSONBig.stringify(flatDialogues, null, 2));

  console.log('Total rows in trees:', totalRowsInTrees);
  console.log('Total rows not found:', notFound);
}

async function packGeneralFromMultipleFilesToSingleFile() {
  const filesPaths = fs.readdirSync(generalFilesFolder);

  const generalTranslated = JSONBig.parse(fs.readFileSync(generalTranslatedFilePath, 'utf8'));

  let translations = {};

  for (const file of filesPaths) {
    const general = JSONBig.parse(fs.readFileSync(generalFilesFolder + '/' + file, 'utf8'));
    translations = { ...translations, ...general };
  }

  for (const key in translations) {
    if (!generalTranslated[key]) {
      console.log(`Can't find in general-translated.json key: ${key}`);
      continue;
    }

    generalTranslated[key] = {
      ...generalTranslated[key],
      belarusian: translations[key].belarusian,
    }
  }

  fs.writeFileSync(generalTranslatedFilePath, JSONBig.stringify(generalTranslated, null, 2));
}

async function packTranslations(unpacked, packed) {
  const translations = JSONBig.parse(fs.readFileSync(unpacked, 'utf8'));
  const original = JSONBig.parse(fs.readFileSync(packed, 'utf8'));

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

  fs.writeFileSync(packed, JSONBig.stringify(original, null, 2));

  if (skippedTranslations.length) {
    console.log('Skipped translations:');
    console.log(skippedTranslations);
    console.log('Total skipped:', skippedTranslations.length)
  }
}

const execute = async () => {
  await Promise.all([
    packDialoguesFromTreesToSingleFile(),
    packGeneralFromMultipleFilesToSingleFile()
  ]);

  for (const file of files) {
    await packTranslations(file.unpacked, file.packed);
  }
}

execute().then(() => console.log('Done'));