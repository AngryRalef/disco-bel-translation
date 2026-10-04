import fs from 'fs';

// Adds the original English text to text/general/*.json entries that don't have it yet.
// The source is the game's own GeneralLockitEnglish, dumped from resources.assets with:
//   dotnet run --project tools/asset-importer -- dump-lockit resources.assets GeneralLockitEnglish text/original/general-english.json
// Existing "english" values are never overwritten (some were hand-corrected). The field is
// inserted as a single new line after the key, so nothing else in the file changes.

const generalEnglishPath = './../../../text/original/general-english.json';
const generalFolder = './../../../text/general';

const applyEnglishToGeneral = () => {
  const english = JSON.parse(fs.readFileSync(generalEnglishPath, 'utf8'));
  const notFound = [];

  for (const file of fs.readdirSync(generalFolder)) {
    const filePath = `${generalFolder}/${file}`;
    let raw = fs.readFileSync(filePath, 'utf8');
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const general = JSON.parse(raw);
    const expected = {};
    let added = 0;

    for (const [key, entry] of Object.entries(general)) {
      if (entry.english !== undefined || english[key] === undefined) {
        if (entry.english === undefined) notFound.push(key);
        expected[key] = entry;
        continue;
      }

      const keyLine = `  ${JSON.stringify(key)}: {${newline}`;
      const index = raw.indexOf(keyLine);
      if (index < 0 || raw.indexOf(keyLine, index + 1) >= 0) {
        throw new Error(`Can't find a unique line for key ${key} in ${file}`);
      }

      const insertAt = index + keyLine.length;
      raw = raw.slice(0, insertAt) + `    "english": ${JSON.stringify(english[key])},${newline}` + raw.slice(insertAt);
      expected[key] = { english: english[key], ...entry };
      added++;
    }

    if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(expected)) {
      throw new Error(`Result doesn't match the expected content for ${file}, nothing written`);
    }

    if (added) fs.writeFileSync(filePath, raw);
    console.log(`${file}: added ${added}`);
  }

  for (const key of notFound) {
    console.log('No English found for key:', key);
  }
}

applyEnglishToGeneral();
