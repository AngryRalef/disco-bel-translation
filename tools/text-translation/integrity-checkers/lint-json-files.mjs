import jsonlint from 'jsonlint';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, './../../..');

const patterns = [
  'text/dialogues/*.json',
  'text/general/*.json',
  'text/translated/*.json',
  'text/additional-dialogues/*.json',
];

const files = await glob(patterns, { cwd: root, absolute: true });
let errors = 0;

for (const filePath of files) {
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    jsonlint.parse(content);
  } catch (e) {
    console.error(`INVALID JSON: ${path.relative(root, filePath)}`);
    console.error(`  ${e.message}`);
    errors++;
  }
}

if (errors === 0) {
  console.log(`All ${files.length} JSON files are valid.`);
} else {
  console.error(`\nFound ${errors} file(s) with JSON errors.`);
  process.exit(1);
}
