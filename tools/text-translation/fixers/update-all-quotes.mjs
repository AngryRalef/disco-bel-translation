import fs from 'fs';
import JSONBig from 'json-bigint';

const dialoguesFolder = './../../../text/dialogues';
const filesToSkip = [
  '107.json',
  '17.json',
  '7.json',
  '6.json',
  '5.json',
  '4.json',
  '416.json',
];

const alternateKeys = [
  'Alternate1',
  'Alternate2',
  'Alternate3',
  'Alternate4',
]

for (const file of fs.readdirSync(dialoguesFolder)) {
    if (filesToSkip.includes(file)) {
        continue;
    }
    const dialogues = JSONBig.parse(fs.readFileSync(dialoguesFolder + '/' + file, 'utf8'));
    
    let totalQuotes = 0;
    let totalQuotesReplaced = 0;

    function replaceQuotes(text) {
        return text.replace(/[“”«»‘’„]/g, '"');
    }

    function findAndReplaceAlternateQuotes(alternates) {
        for (const alternateKey in alternateKeys) {
            const alternate = alternates[alternateKeys[alternateKey]];

            if (alternate && alternate.belarusian) {
                const originalText = alternate.belarusian;
                const newText = replaceQuotes(originalText);

                if (originalText !== newText) {
                    totalQuotes++;
                    totalQuotesReplaced++;
                    alternates[alternateKeys[alternateKey]].belarusian = newText;
                }
            }
        }
    }
    
    function traverseTreeRecursively(links) {
        for (const link of links) {
            if (link.belarusian) {
                const originalText = link.belarusian;
                const newText = replaceQuotes(originalText);
                
                if (originalText !== newText) {
                    totalQuotes++;
                    totalQuotesReplaced++;
                    link.belarusian = newText;
                }
            }

            if (link.alternates) {
                findAndReplaceAlternateQuotes(link.alternates);
            }
            
            if (link.links) {
                traverseTreeRecursively(link.links);
            }
        }
    }
    
    traverseTreeRecursively(dialogues.dialogueTree);

    if (totalQuotesReplaced === 0) {
        console.log(`No quotes found in ${file}`);
        continue;
    }

    fs.writeFileSync(dialoguesFolder + '/' + file, JSONBig.stringify(dialogues, null, 2));
    
    console.log('Total quotes:', totalQuotes);
    console.log('Total quotes replaced:', totalQuotesReplaced);
}