/**
 * convert-dialogues-format.mjs
 *
 * Converts dialogue files to the translator-friendly format:
 *
 *   before                                   after
 *   {                                        {
 *     "id": 12,                                "id": 12,
 *     "redacted": false,                       "articyId": "0x0100...",
 *     "title": "Kim Kitsuragi: \"...\"",       "speaker": "Kim Kitsuragi -> You",
 *     "actor": "Kim Kitsuragi",                "english": "...",
 *     "to": "You",                             "polish": "...",
 *     "articyId": "0x0100...",                 "belarusian": "...",
 *     "english": "...",                        "alternates": { ... },
 *     "polish": "...",                         "links": [ ... ]
 *     "belarusian": "...",                   }
 *     "alternates": { ... },
 *     "links": [ ... ]
 *   }
 *
 * "title" and "redacted" are dropped ("redacted" is still kept in
 * text/translated/dialogues-translated.json). A missing actor or addressee (null)
 * becomes "N/A" in "speaker". Nodes that never had actor/to get no "speaker".
 *
 * Safe to run any number of times and on files in either format (already converted
 * nodes are left as they are), so a branch with work in progress can convert its own
 * files before merging.
 *
 * Usage (from anywhere):
 *   node tools/text-translation/converters/convert-dialogues-format.mjs [file-or-folder ...]
 *
 * Default: text/dialogues and text/additional-dialogues. Afterwards, verify with
 *   node tools/text-translation/integrity-checkers/check-dialogues-conversion.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const defaultTargets = ['text/dialogues', 'text/additional-dialogues'].map((f) => path.join(root, f));

const NA = 'N/A';
const ARROW = ' -> ';
const DROPPED_KEYS = ['title', 'redacted'];
const SPEAKER_KEYS = ['actor', 'to'];

function speakerPart(value, where) {
  if (value === null) return NA;
  if (typeof value !== 'string' || value === '' || value === NA || value.includes(ARROW.trim())) {
    throw new Error(`${where}: can't safely store ${JSON.stringify(value)} in "speaker"`);
  }
  return value;
}

export function convertNode(node, where) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${where}: node is not an object`);
  }

  const hasActor = 'actor' in node;
  const hasTo = 'to' in node;
  if (hasActor !== hasTo) throw new Error(`${where}: has only one of actor/to`);
  if (hasActor && 'speaker' in node) throw new Error(`${where}: has both speaker and actor/to`);

  const out = { id: node.id };
  if ('articyId' in node) out.articyId = node.articyId;
  if (hasActor) out.speaker = `${speakerPart(node.actor, `${where}.actor`)}${ARROW}${speakerPart(node.to, `${where}.to`)}`;
  else if ('speaker' in node) out.speaker = node.speaker;

  for (const [key, value] of Object.entries(node)) {
    if (key in out || key === 'links' || DROPPED_KEYS.includes(key) || SPEAKER_KEYS.includes(key)) continue;
    out[key] = value;
  }

  if ('links' in node) {
    if (!Array.isArray(node.links)) throw new Error(`${where}: links is not an array`);
    out.links = node.links.map((child, i) => convertNode(child, `${where}.links[${i}]`));
  }

  return out;
}

export function convertDialogue(dialogue, where) {
  if (!Array.isArray(dialogue.dialogueTree)) return dialogue;
  return {
    ...dialogue,
    dialogueTree: dialogue.dialogueTree.map((node, i) => convertNode(node, `${where} dialogueTree[${i}]`)),
  };
}

function collectFiles(targets) {
  const files = [];
  for (const target of targets) {
    const full = path.resolve(target);
    if (fs.statSync(full).isDirectory()) {
      for (const name of fs.readdirSync(full).filter((n) => n.endsWith('.json')).sort()) files.push(path.join(full, name));
    } else {
      files.push(full);
    }
  }
  return files;
}

function main() {
  const targets = process.argv.slice(2);
  const files = collectFiles(targets.length ? targets : defaultTargets);

  // Convert everything in memory first, write only if every file converted cleanly.
  const results = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const trailing = /\r?\n$/.test(raw) ? newline : '';
    const converted = convertDialogue(JSON.parse(raw), path.relative(root, file));
    const output = JSON.stringify(converted, null, 2).replace(/\n/g, newline) + trailing;
    results.push({ file, changed: output !== raw, output });
  }

  let changed = 0;
  for (const { file, changed: isChanged, output } of results) {
    if (!isChanged) continue;
    fs.writeFileSync(file, output, 'utf8');
    changed++;
  }

  console.log(`Converted ${changed} of ${files.length} file(s) (${files.length - changed} already up to date).`);
  console.log('Verify with: node tools/text-translation/integrity-checkers/check-dialogues-conversion.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
