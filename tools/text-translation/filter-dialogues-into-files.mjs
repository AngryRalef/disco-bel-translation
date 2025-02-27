import fs from 'fs';

const dialoguesTreePath = './../../text/dialogues-tree.json';

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

async function createDialogueFile(filename, data) {
  if (!fs.existsSync('./../../text/dialogues')) {
    fs.mkdirSync('./../../text/dialogues');
  }

  fs.writeFileSync(`./../../text/dialogues/${filename}.json`, JSON.stringify(data, null, 2));
}

async function findDialogueEntryById(dialogueEntries, id) {
  return dialogueEntries.find(dialogueEntry => dialogueEntry.id === id);
}

async function getDialogueEntriesRecursive(allEntries, dialogueEntry, visitedEntries = []) {
  const dialogueEntries = [];

  if (!dialogueEntry) {
    return null;
  }
  if (visitedEntries.includes(dialogueEntry.id)) {
    return null;
  }

  completedEntries.push(dialogueEntry.id);

  for (const outgoingLink of dialogueEntry.outgoingLinks.Array) {
    const nextDialogueEntry = await findDialogueEntryById(allEntries, outgoingLink.destinationDialogueID);
    dialogueEntries.push(await getDialogueEntriesRecursive(allEntries, nextDialogueEntry, completedEntries));
  }

  return {
    id: dialogueEntry.id,
    title: dialogueEntry.fields.Array.find(field => field.title === 'Title')?.value,
    articyId: dialogueEntry.fields.Array.find(field => field.title === 'Articy Id')?.value,
    text: dialogueEntry.fields.Array.find(field => field.title === 'Dialogue Text')?.value,
    dialogueEntries,
  }
}

async function buildFullTree(dialogues) {
  const dialogueMap = new Map();

  // Create a map of ID to dialogue objects for easy lookup
  dialogues.forEach(dialogue => {
    dialogueMap.set(dialogue.id, { ...dialogue, links: [...dialogue.outgoingLinks.Array] });
  });

  let startDialogue = await findRootDialogueEntry(dialogues);

  const visited = new Set();
  const queue = [{ parent: null, node: startDialogue }];
  const resultMap = new Map();

  while (queue.length) {
    const { parent, node } = queue.shift();
    if (!node || visited.has(node.id)) continue;

    visited.add(node.id);

    const treeNode = {
      id: node.id,
      title: node.fields.Array.find(field => field.title === 'Title')?.value,
      articyId: node.fields.Array.find(field => field.title === 'Articy Id')?.value,
      text: node.fields.Array.find(field => field.title === 'Dialogue Text')?.value,
      links: []
    };
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

async function buildDialogueTree(dialogues) {
  let fullTree = await buildFullTree(dialogues);

  const hiddenSet = new Set(dialogues.filter(d => !d.fields.Array.find(field => field.title === 'Dialogue Text')).map(d => d.id));
  return removeHiddenNodes(fullTree, hiddenSet);
}

async function filterDialoguesIntoFiles() {
  const dialoguesTree = JSON.parse(fs.readFileSync(dialoguesTreePath, 'utf8'));

  const conversations = dialoguesTree.conversations.Array;

  let counter = 0;

  for (const conversation of conversations) {
    console.log(`Processing conversation ${counter}`);

    const conversationId = conversation.fields.Array.find(field => field.title === 'Articy Id')?.value;
    const conversationTitle = conversation.fields.Array.find(field => field.title === 'Title')?.value;
    const conversationDescription = conversation.fields.Array.find(field => field.title === 'Description')?.value;

    const dialogueTree = await buildDialogueTree(conversation.dialogueEntries.Array);

    if (!dialogueTree.length) {
      console.log(`No dialogue tree found for conversation ${counter}`);
      continue;
    }

    await createDialogueFile(counter, {
      id: conversationId,
      title: conversationTitle,
      description: conversationDescription,
      dialogueTree,
    });

    counter++;
  }
}

filterDialoguesIntoFiles().catch(console.error);