import fs from 'fs';
import JSONBig from "json-bigint";

const middleTranslationFile = './../../../text/translated/dialogues-translated.json';
const extractedDialogueTree = './../../../text/dialogues-tree-english.json';
const dialoguesFolder = './../../../text/dialogues';
const dialoguesTreePath = './../../../text/dialogues-tree.json';

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

async function checkDialoguesUnpacking() {
  // step 1: Check if dialogues from a tree has a file in dialogues folder, compare by the title of dialogue
  const dialogueTree = JSONBig.parse(fs.readFileSync(dialoguesTreePath, 'utf8'));
  let dialogueTitles = new Set();

  /**
   * @type {Array<{
   *    fields: {
   *      Array: Array<{
   *        title: string,
   *        value: string
   *      }>
   *    }
   * }>}
   */
  const conversations = dialogueTree.conversations.Array;

  let incorrectFiles = [];
  let emptyTitles = [];

  for (const conversation of conversations) {
    // console.log(`Checking conversation: ${conversation.id}`);
    const titleField = conversation.fields.Array.find(field => field.title === 'Title');
    if (titleField) {
      dialogueTitles.add(titleField.value);
    }
    if (!titleField || !titleField.value) {
      emptyTitles.push({ id: conversation.id, title: titleField ? titleField.value : 'undefined' });
      console.log(`Conversation ${conversation.id} has an empty or undefined title.`);
    }
  }

  const dialogueFiles = fs.readdirSync(dialoguesFolder).filter(file => file.endsWith('.json'));
  let fileTitles = new Set();

  for (const file of dialogueFiles) {
    const dialogueContent = JSONBig.parse(fs.readFileSync(`${dialoguesFolder}/${file}`, 'utf8'));

    const title = dialogueContent.title;

    if (title) {
      fileTitles.add(title);
    }
  }

  // compare titles from dialogue tree with titles from files
  for (const title of dialogueTitles) {
    if (!fileTitles.has(title)) {
      incorrectFiles.push(title);
      console.log(`Missing file for dialogue title: ${title}`);
    }
  }

  console.log(`Total dialogues in tree: ${dialogueTitles.size}`);
  console.log(`Total dialogue files found: ${fileTitles.size}`);
  console.log(`Incorrect files: ${incorrectFiles.length}`);
}

// checkIntegrityMiddleAndExtracted().then(() => console.log('Done'));

console.log('Checking if all dialogues are unpacked...');
checkDialoguesUnpacking().then(() => console.log('Done checking dialogues unpacking'));