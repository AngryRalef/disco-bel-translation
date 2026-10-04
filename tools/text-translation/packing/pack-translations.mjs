import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSONBig from 'json-bigint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const textDir = path.join(__dirname, '../../../text');
const translatedDir = path.join(textDir, 'translated');

const dialoguesTreeFolders = [path.join(textDir, 'dialogues'), path.join(textDir, 'additional-dialogues')];
const flatDialoguesFilePath = path.join(translatedDir, 'dialogues-translated.json');

const generalFilesFolder = path.join(textDir, 'general');
const generalTranslatedFilePath = path.join(translatedDir, 'general-translated.json');

const files = [
  {
    packed: path.join(translatedDir, 'GeneralLockitSpanish-CAB-d60e2740a0d8c8bcedcc6e25a73023dc--3226765757514329824.json'),
    unpacked: generalTranslatedFilePath
  },
  {
    packed: path.join(translatedDir, 'DialoguesLockitSpanish-CAB-d60e2740a0d8c8bcedcc6e25a73023dc--7891955455278724077.json'),
    unpacked: flatDialoguesFilePath
  }
]

// Collects every translation from the dialogue files as lockit keys:
// "Dialogue Text/<articyId>" for a line and "<AlternateN>/<articyId>" for its alternates.
// Nodes without "belarusian" are skipped: untranslated test nodes, and context-only nodes
// ("translatedIn") whose translation lives in another file.
// A line translated differently in two files is an error - the game can only hold one text,
// so nothing is written until it's fixed (see converters/dedupe-additional-dialogues.mjs).
function collectDialogueTranslations() {
  const translations = new Map(); // key -> { text, file }
  const conflicts = [];
  const counts = { lines: 0, alternates: 0 };

  function add(key, text, file) {
    const existing = translations.get(key);
    if (existing) {
      if (existing.text !== text) conflicts.push(`${key}: ${existing.file} and ${file} have different translations`);
      return;
    }
    translations.set(key, { text, file });
    counts[key.startsWith('Dialogue Text/') ? 'lines' : 'alternates']++;
  }

  function collect(nodes, file) {
    for (const node of nodes || []) {
      if (typeof node.belarusian === 'string') add(`Dialogue Text/${node.articyId}`, node.belarusian, file);

      if (node.alternates && typeof node.alternates === 'object') {
        for (const [alternateKey, alternate] of Object.entries(node.alternates)) {
          if (alternate && typeof alternate.belarusian === 'string') {
            add(`${alternateKey}/${node.articyId}`, alternate.belarusian, file);
          }
        }
      }

      collect(node.links, file);
    }
  }

  for (const folder of dialoguesTreeFolders) {
    for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.json')).sort()) {
      const dialogues = JSONBig.parse(fs.readFileSync(folder + '/' + file, 'utf8'));
      collect(dialogues.dialogueTree, `${path.basename(folder)}/${file}`);
    }
  }

  if (conflicts.length) {
    throw new Error(`${conflicts.length} line(s) have different translations in different files, nothing was written:\n  ${conflicts.join('\n  ')}`);
  }

  return { translations, counts };
}

async function packDialoguesFromTreesToSingleFile() {
  const { translations, counts } = collectDialogueTranslations();

  const flatDialogues = JSONBig.parse(fs.readFileSync(flatDialoguesFilePath, 'utf8'));

  let notFound = 0;

  for (const [key, { text }] of translations) {
    if (!flatDialogues[key]) {
      console.log(`Can't find in dialogues-translated.json key: ${key}`);
      notFound++;
      continue;
    }

    flatDialogues[key].belarusian = text;
  }

  fs.writeFileSync(flatDialoguesFilePath, JSONBig.stringify(flatDialogues, null, 2));

  console.log('Total rows in trees:', counts.lines);
  console.log('Total alternates in trees:', counts.alternates);
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
  // One after another, so a failure in the dialogues (e.g. conflicting translations) stops
  // everything before any file is written.
  await packDialoguesFromTreesToSingleFile();
  await packGeneralFromMultipleFilesToSingleFile();

  for (const file of files) {
    await packTranslations(file.unpacked, file.packed);
  }
}

execute().then(() => console.log('Done')).catch((error) => {
  console.error(`Packing failed: ${error.message}`);
  process.exit(1);
});