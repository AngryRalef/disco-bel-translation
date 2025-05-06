import fs from 'fs';
import JSONBig from 'json-bigint';

const dialoguesFolder = './../../../text/dialogues';
const filesToProcess = [
  '7.json',
];

const alternateKeys = [
  'Alternate1',
  'Alternate2',
  'Alternate3',
  'Alternate4',
]

for (const file of fs.readdirSync(dialoguesFolder)) {
  if (!filesToProcess.includes(file)) {
    continue;
  }
  const dialogues = JSONBig.parse(fs.readFileSync(dialoguesFolder + '/' + file, 'utf8'));

  let totalFound = 0;

  function replaceHyphens(text) {
    return text.replace(/ - /g, ' — ').replace(/ -- /g, ' — ');
  }

  function findAndReplaceAlternate(alternates) {
    for (const alternateKey in alternateKeys) {
      const alternate = alternates[alternateKeys[alternateKey]];

      if (alternate && alternate.belarusian) {
        const originalText = alternate.belarusian;
        const newText = replaceHyphens(originalText);

        if (originalText !== newText) {
          totalFound++;
          alternates[alternateKeys[alternateKey]].belarusian = newText;
        }
      }
    }
  }

  function traverseTreeRecursively(links) {
    for (const link of links) {
      if (link.belarusian) {
        const originalText = link.belarusian;
        const newText = replaceHyphens(originalText);

        if (originalText !== newText) {
          totalFound++;
          link.belarusian = newText;
        }
      }

      if (link.alternates) {
        findAndReplaceAlternate(link.alternates);
      }

      if (link.links) {
        traverseTreeRecursively(link.links);
      }
    }
  }

  traverseTreeRecursively(dialogues.dialogueTree);

  if (totalFound === 0) {
    console.log(`No found replaced in ${file}`);
    continue;
  }

  fs.writeFileSync(dialoguesFolder + '/' + file, JSONBig.stringify(dialogues, null, 2));

  console.log('Total found:', totalFound);
}