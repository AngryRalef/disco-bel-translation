import JSONBig from "json-bigint";
import fs from "fs";

const pathToDialogueTree = './../../../text/dialogues-tree.json';

// path to the dialogue fields: conversations.Array[].dialogueEntries.Array[].fields.Array[]
const getEnglishTextFromDialogueTree = function (dialogueTree) {
  const englishText = {};

  const actors = getActors(dialogueTree);

  dialogueTree.conversations.Array.forEach(conversation => {
    conversation.dialogueEntries.Array.forEach(dialogueEntry => {
      const id = dialogueEntry.fields.Array.find(field => field.title === 'Articy Id')?.value;
      const text = dialogueEntry.fields.Array.find(field => field.title === 'Dialogue Text')?.value;
      const actor = dialogueEntry.fields.Array.find(field => field.title === 'Actor')?.value;
      const to = dialogueEntry.fields.Array.find(field => field.title === 'Conversant')?.value;

      if (!id || !text) {
        console.log('Error: dialogue entry without id or text');

        if (!text) {
          console.log('Conversation id:', conversation.id);
          console.log('Fields:', dialogueEntry.fields.Array);
        }
        return;
      }
      englishText[id] = { text, actor: actors[actor], to: actors[to] };
    });
  });
  return englishText;
}

const getActors = function (dialogueTree) {
  const actors = {};
  dialogueTree.actors.Array.forEach(actor => {
    actors[actor.id] = actor.fields.Array.find(field => field.title === 'Name')?.value;
  });
  return actors;
}

const execute = async () => {
  const dialogueTree = JSONBig.parse(fs.readFileSync(pathToDialogueTree, 'utf8'));
  const englishText = getEnglishTextFromDialogueTree(dialogueTree);

  fs.writeFileSync('./../../../text/dialogues-tree-english.json', JSONBig.stringify(englishText, null, 2));
}

execute().then(() => console.log('Done'));