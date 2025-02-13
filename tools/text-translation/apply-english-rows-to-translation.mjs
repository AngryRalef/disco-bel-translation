import fs from "fs";
import JSONBig from "json-bigint";

const simplifiedEnglishRowsPath = '../../text/dialogues-tree-english.json';
const dialoguesTranslatedPath = '../../text/translated/dialogues-translated.json';

const applyEnglishRowsToTranslation = async () => {
  const simplifiedEnglishRows = JSONBig.parse(fs.readFileSync(simplifiedEnglishRowsPath, 'utf8'));
  const dialoguesTranslated = JSONBig.parse(fs.readFileSync(dialoguesTranslatedPath, 'utf8'));

  for (const key in simplifiedEnglishRows) {
    const fullKey = `Dialogue Text/${key}`;
    if (!dialoguesTranslated[fullKey]) {
      console.log('Error: missing translation for key:', fullKey);
      continue;
    }

    dialoguesTranslated[fullKey] = {
      redacted: dialoguesTranslated[fullKey]?.redacted || false,
      actor: simplifiedEnglishRows[key].actor ?? null,
      to: simplifiedEnglishRows[key].to ?? null,
      english: simplifiedEnglishRows[key].text,
      polish: dialoguesTranslated[fullKey].polish,
      belarusian: dialoguesTranslated[fullKey].belarusian,
    }
  }

  fs.writeFileSync(dialoguesTranslatedPath, JSONBig.stringify(dialoguesTranslated, null, 2));
}

applyEnglishRowsToTranslation().then(() => console.log('Done'));