import fs from 'fs';
import * as crypto from "node:crypto";

const dialoguesTreePath = './../../../text/dialogues-tree.json';
const translations = JSON.parse(fs.readFileSync('./../../../text/translated/dialogues-translated.json', 'utf8'));
const alternatesField = ['Alternate1', 'Alternate2', 'Alternate3', 'Alternate4'];
const dialoguesFolder = './../../../text/dialogues';
const conversationsWithOutgoingLinksPath = './../../../text/dialogues-outgoing-links.json';
const additionalDialoguesFolder = './../../../text/additional-dialogues';

async function findRootDialogueEntry(dialogueEntries) {
  if (!dialogueEntries) {
    throw new Error('No dialogue entries found');
  }

  const startDialogueEntry = dialogueEntries.find(dialogueEntry => dialogueEntry.fields.Array.find(field => field.title === 'Title')?.value === 'START');

  if (!startDialogueEntry) {
    throw new Error('No start dialogue entry found');
  }

  return startDialogueEntry;
}

async function createDialogueFile(folder, filename, data) {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder);
  }

  fs.writeFileSync(`${folder}/${filename}.json`, JSON.stringify(data, null, 2));
}

async function getAlternatesFromFields(fields) {
  return fields.Array.reduce((acc, field) => {
    if (alternatesField.includes(field.title)) {
      acc[field.title] = field.value;
    }
    return acc;
  }, {});
}

async function buildFullTree(dialogues, startDialogue = null) {
  const dialogueMap = new Map();

  // Create a map of ID to dialogue objects for easy lookup
  dialogues.forEach(dialogue => {
    dialogueMap.set(dialogue.id, { ...dialogue, links: [...dialogue.outgoingLinks.Array] });
  });

  if (!startDialogue) {
    startDialogue = await findRootDialogueEntry(dialogues);
  }

  const visited = new Set();
  const queue = [{ parent: null, node: startDialogue }];
  const resultMap = new Map();

  while (queue.length) {
    const { parent, node } = queue.shift();
    if (!node || visited.has(node.id)) continue;

    visited.add(node.id);

    const treeNode = await getTranslationForDialogue({
      id: node.id,
      title: node.fields.Array.find(field => field.title === 'Title')?.value,
      articyId: node.fields.Array.find(field => field.title === 'Articy Id')?.value,
      text: node.fields.Array.find(field => field.title === 'Dialogue Text')?.value,
      alternates: await getAlternatesFromFields(node.fields),
      links: []
    });
    resultMap.set(node.id, treeNode);

    if (parent) {
      resultMap.get(parent.id).links.push(treeNode);
    }

    for (const link of node.outgoingLinks.Array) {
      const linkId = link.destinationDialogueID;
      if (dialogueMap.has(linkId)) {
        queue.push({ parent: treeNode, node: dialogueMap.get(linkId) });
      }
    }
  }

  return resultMap.get(startDialogue.id);
}

function removeHiddenNodes(tree, hiddenSet) {
  if (!tree) return null;

  let newChildren = [];

  for (const child of tree.links) {
    const cleanedChild = removeHiddenNodes(child, hiddenSet);
    if (cleanedChild) {
      if (Array.isArray(cleanedChild)) {
        newChildren.push(...cleanedChild); // Flatten children when merging
      } else {
        newChildren.push(cleanedChild);
      }
    }
  }

  tree.links = newChildren;

  // If this node is hidden, return its children (merge them into the parent)
  return hiddenSet.has(tree.id) ? tree.links : tree;
}

async function buildDialogueTree(dialogues, startDialogue = null) {
  let fullTree = await buildFullTree(dialogues, startDialogue);

  const hiddenSet = new Set(dialogues.filter(d => !d.fields.Array.find(field => field.title === 'Dialogue Text')).map(d => d.id));
  return removeHiddenNodes(fullTree, hiddenSet);
}

async function getTranslationForAlternates(alternates, articyId) {
  return alternatesField.reduce((acc, field) => {
    const translation = translations[`${field}/${articyId}`];
    const alternate = alternates[field];
    if (translation && alternate) {
      acc[field] = {
        english: alternate,
        polish: translation.polish,
        belarusian: translation.belarusian,
      }
    }
    return acc;
  }, {});
}

async function getTranslationForDialogue(dialogue) {
  const translation = translations[`Dialogue Text/${dialogue.articyId}`];

  if (!translation) {
    return dialogue;
  }

  const alternates = await getTranslationForAlternates(dialogue.alternates, dialogue.articyId);

  return {
    id: dialogue.id,
    title: dialogue.title,
    actor: translation.actor,
    to: translation.to,
    articyId: dialogue.articyId,
    english: dialogue.text,
    polish: translation.polish,
    belarusian: translation.belarusian,
    ...(Object.keys(alternates).length ? { alternates } : {}),
    links: dialogue.links,
  }
}

async function getAllIncomingEntries(conversation, conversationsWithOutgoingLinks) {
  let allIncomingEntries = [];

  for (const outgoingConversation of conversationsWithOutgoingLinks) {
    for (const entry of outgoingConversation.dialogueEntriesWithLinks) {
      const links = entry.outgoingConversations.filter(link => link.destinationConversationID === conversation.id);

      for (const link of links) {
        const incomingEntry = conversation.dialogueEntries.Array.find(e => e.id === link.destinationDialogueID);

        if (incomingEntry) {
          allIncomingEntries.push(incomingEntry);
        }
      }
    }
  }

  return allIncomingEntries;
}

async function deleteDuplicateFiles(folder) {
  const files = fs.readdirSync(folder);
  const seen = new Set();

  for (const file of files) {
    const filePath = `${folder}/${file}`;
    const content = fs.readFileSync(filePath, 'utf8');
    const hash = crypto.createHash('md5').update(content).digest('hex');
    if (seen.has(hash)) {
      console.log(`Deleting duplicate file: ${file}`);
      fs.unlinkSync(filePath);
    } else {
      seen.add(hash);
    }
  }
}

async function filterDialoguesIntoFiles() {
  const dialoguesTree = JSON.parse(fs.readFileSync(dialoguesTreePath, 'utf8'));
  const conversationsWithOutgoingLinks = JSON.parse(fs.readFileSync(conversationsWithOutgoingLinksPath, 'utf8'));

  const conversations = dialoguesTree.conversations.Array;

  let counter = 0;

  for (const conversation of conversations) {
    console.log(`Processing conversation ${conversation.id}`);

    const conversationId = conversation.fields.Array.find(field => field.title === 'Articy Id')?.value;
    const conversationTitle = conversation.fields.Array.find(field => field.title === 'Title')?.value;
    const conversationDescription = conversation.fields.Array.find(field => field.title === 'Description')?.value;

    const dialogueTree = await buildDialogueTree(conversation.dialogueEntries.Array);

    if (!dialogueTree.length) {
      console.log(`No dialogue tree found for conversation ${conversation.id}`);

      const hasLinkToThisConversation = conversationsWithOutgoingLinks.some(outgoingConversation => {
        return outgoingConversation.dialogueEntriesWithLinks.some(entry =>
          entry.outgoingConversations.some(link => link.destinationConversationID === conversation.id)
        );
      });

      if (hasLinkToThisConversation) {
        console.log(`Found empty conversation that has links to it: ${conversationId} - ${conversationTitle}`);

        const incomingEntries = await getAllIncomingEntries(conversation, conversationsWithOutgoingLinks);

        for (const incomingEntry of incomingEntries) {
          const incomingDialogueTree = await buildDialogueTree(conversation.dialogueEntries.Array, incomingEntry);

          if (incomingDialogueTree.length) {
            await createDialogueFile(additionalDialoguesFolder, `${counter}-${conversation.id}`, {
              id: conversationId,
              title: conversationTitle,
              description: conversationDescription,
              dialogueTree: incomingDialogueTree,
            });
            counter++;
          } else {
            console.log(`No dialogue tree found for incoming entry ${incomingEntry.id}`);
          }
        }
      }

      continue;
    }

    await createDialogueFile(dialoguesFolder, counter, {
      id: conversationId,
      title: conversationTitle,
      description: conversationDescription,
      dialogueTree,
    });

    counter++;
  }

  await deleteDuplicateFiles(additionalDialoguesFolder);
}

filterDialoguesIntoFiles().catch(console.error);