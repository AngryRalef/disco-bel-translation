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

    dialoguesTranslated[fullKey].english = simplifiedEnglishRows[key].text;

    if (simplifiedEnglishRows[key].actor) {
      dialoguesTranslated[fullKey].actor = simplifiedEnglishRows[key].actor;
    }

    if (simplifiedEnglishRows[key].to) {
      dialoguesTranslated[fullKey].to = simplifiedEnglishRows[key].to;
    }

    if (!dialoguesTranslated[key].redacted) {
      dialoguesTranslated[fullKey].redacted = false;
    }
  }

  fs.writeFileSync(dialoguesTranslatedPath, JSONBig.stringify(dialoguesTranslated, null, 2));
}

applyEnglishRowsToTranslation().then(() => console.log('Done'));