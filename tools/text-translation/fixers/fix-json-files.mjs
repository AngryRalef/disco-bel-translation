import { jsonrepair } from 'jsonrepair';
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
let fixed = 0;
let failed = 0;

for (const filePath of files) {
  const content = fs.readFileSync(filePath, 'utf8');

  try {
    jsonlint.parse(content);
  } catch {
    const relativePath = path.relative(root, filePath);
    try {
      const repaired = jsonrepair(content);
      fs.writeFileSync(filePath, repaired, 'utf8');
      console.log(`Fixed: ${relativePath}`);
      fixed++;
    } catch (e) {
      console.error(`Could not fix: ${relativePath}`);
      console.error(`  ${e.message}`);
      failed++;
    }
  }
}

if (fixed === 0 && failed === 0) {
  console.log('No issues found.');
} else {
  if (fixed) console.log(`\nFixed ${fixed} file(s).`);
  if (failed) console.error(`Could not fix ${failed} file(s) — manual intervention required.`);
}
