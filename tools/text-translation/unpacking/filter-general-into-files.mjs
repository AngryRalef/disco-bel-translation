import fs from 'fs';
import JSONBig from 'json-bigint';

const generalTranslatedFilePath = './../../../text/translated/general-translated.json';

const generalTranslated = JSONBig.parse(fs.readFileSync(generalTranslatedFilePath, 'utf8'));

const categories = {
  'Abilities/': 'abilities',
  'Actors/': 'actors',
  'Conversation/': 'conversations',
  'Items/': 'items',
  'Messages/': 'messages',
  'Skills/': 'skills',
  'Thoughts/': 'thoughts',
  'Buttons/': 'buttons',
  'Area Names/': 'areaNames',
};

const data = Object.fromEntries(Object.values(categories).map((key) => [key, {}]));
data.other = {};

for (const key in generalTranslated) {
  let matched = false;
  delete generalTranslated[key].redacted;

  for (const prefix in categories) {
    if (key.startsWith(prefix)) {
      const category = categories[prefix];
      if (generalTranslated[key].belarusian === 'Not to translate'
        || generalTranslated[key].polish === 'Not to translate'
        || generalTranslated[key].polish === '')
      {
        matched = true;
        break;
      }
      data[category][key] = generalTranslated[key];
      matched = true;
      break;
    }
  }

  if (!matched) {
    data['other'][key] = generalTranslated[key]
  }
}

for (const category in data) {
  const filePath = `./../../../text/general/${category}.json`;

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(filePath.replace(/\/[^/]+$/, ''), { recursive: true });
  }

  fs.writeFileSync(filePath, JSONBig.stringify(data[category], null, 2));
}