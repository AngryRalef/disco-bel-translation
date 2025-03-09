// get translations that are longer than 325 characters
import fs from 'fs';

async function getLongestRows() {
  const translations = JSON.parse(fs.readFileSync('general-translated.json', 'utf8'));
  let longestRows = {};

  // iterate through translations object
  for (const [key, translation] of Object.entries(translations)) {
    if (translation.polish.length > 325) {
      longestRows[key] = translation;
    }
  }

  if (!fs.existsSync('longest-rows.json')) {
    fs.writeFileSync('longest-rows.json', '{}', 'utf8');
  }
  fs.writeFileSync('longest-rows.json', JSON.stringify(longestRows, null, 2), 'utf8');
}

async function packLongestRowsBack() {
  const longestRows = JSON.parse(fs.readFileSync('longest-rows.json', 'utf8'));
  const translations = JSON.parse(fs.readFileSync('general-translated.json', 'utf8'));

  longestRows.forEach((row) => {
    const index = translations.findIndex((translation) => translation.id === row.id);
    translations[index] = row;
  });

  fs.writeFileSync('general-translated.json', JSON.stringify(translations), 'utf8');
}

getLongestRows();