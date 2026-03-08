import fs from 'fs';
import JSONBig from "json-bigint";

const dialoguesTreePath = './../../../text/dialogues-tree.json';

// Example structure of conversationsLinks
// let conversationsLinks = [
//   {
//     id: 123,
//     title: 'Conversation Title',
//     dialogueEntriesWithLinks: [
//       {
//         id: 456,
//         text: 'Dialogue Entry Text',
//         outgoingConversations: [
//           {
//             originConversationID: 5,
//             originDialogueID: 5,
//             destinationConversationID: 5,
//             destinationDialogueID: 13,
//             isConnector: 0,
//             priority: 2
//           }
//         ]
//       }
//     ]
//   }
// ]
let conversationsLinks = [];
let mentionedConversations = new Set();

async function findOutgoingLinksToAnotherConversation(conversation) {
  let dialogueEntriesWithLinks = [];
  for (const dialogueEntry of conversation.dialogueEntries.Array) {
    const links = dialogueEntry.outgoingLinks.Array;
    let outgoingConversations = [];

    for (const link of links) {
      if (link.destinationConversationID !== link.originConversationID) {
        outgoingConversations.push(link);

        if (!mentionedConversations.has(link.destinationConversationID)) {
          mentionedConversations.add(link.destinationConversationID);
        }
      }
    }

    if (outgoingConversations.length > 0) {
      dialogueEntriesWithLinks.push({
        id: dialogueEntry.id,
        text: dialogueEntry.fields.Array.find(field => field.title === 'Dialogue Text')?.value || '',
        outgoingConversations: outgoingConversations
      });
    }
  }

  if (dialogueEntriesWithLinks.length > 0) {
    conversationsLinks.push({
      id: conversation.id,
      title: conversation.fields.Array.find(field => field.title === 'Title')?.value || '',
      dialogueEntriesWithLinks: dialogueEntriesWithLinks
    });
  }
}

async function iterateConversations() {
  const wholeTree = JSONBig.parse(fs.readFileSync(dialoguesTreePath, 'utf8'));

  const conversations = wholeTree.conversations.Array;
  for (const conversation of conversations) {
    await findOutgoingLinksToAnotherConversation(conversation);
  }
}

iterateConversations().then(() => {
  const outputFilePath = './../../../text/dialogues-outgoing-links.json';
  fs.writeFileSync(outputFilePath, JSONBig.stringify(conversationsLinks, null, 2));
  console.log(`Outgoing links to another conversation saved to ${outputFilePath}`);

  const mentionedConversationsFilePath = './../../../text/mentioned-conversations.json';
  const orderedMentionedConversations = Array.from(mentionedConversations).sort((a, b) => a - b);
  fs.writeFileSync(mentionedConversationsFilePath, JSONBig.stringify(orderedMentionedConversations, null, 2));
  console.log(`Mentioned conversations saved to ${mentionedConversationsFilePath}`);
}).catch((error) => {
  console.error('Error:', error);
});
