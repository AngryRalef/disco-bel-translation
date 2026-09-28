/**
 * dedupe-additional-dialogues.mjs
 *
 * Makes every dialogue line translatable in exactly one file.
 *
 * Why: an additional dialogue is written once per way into a conversation (see
 * unpacking/filter-dialogues-into-files.mjs), and different ways in often reach the same
 * lines - so the same line ended up in 2-3 files, translated differently in each, while
 * the game can only hold one text per line.
 *
 * What it does, in text/additional-dialogues only (text/dialogues is never changed):
 *   1. Deletes a file whose lines are all contained in another single file (nothing is
 *      lost - the other file has every one of them). Of two files with exactly the same
 *      lines, the first one is kept.
 *   2. Every remaining shared line is owned by the first file that has it (text/dialogues
 *      first, then additional dialogues by number). In the other files that line stays in
 *      place for context, but without "polish"/"belarusian" and with
 *      "translatedIn": "<owner file>" - there's nothing to edit there.
 *
 * Safe to run any number of times. Usage (from anywhere):
 *   node tools/text-translation/converters/dedupe-additional-dialogues.mjs [--dry-run]
 * Then verify with:
 *   node tools/text-translation/integrity-checkers/check-dialogues-dedupe.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TRANSLATION_KEYS = ['polish', 'belarusian'];

export function isReference(node) {
  return typeof node.translatedIn === 'string';
}

function walk(nodes, visit) {
  for (const node of nodes || []) {
    visit(node);
    walk(node.links, visit);
  }
}

function articyIds(dialogue) {
  const ids = new Set();
  walk(dialogue.dialogueTree, (node) => ids.add(node.articyId));
  return ids;
}

function isSubset(a, b) {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// text/dialogues first, then additional dialogues by their leading number ("30-71.json")
function fileOrder(a, b) {
  const rank = (name) => (name.startsWith('dialogues/') ? 0 : 1);
  const num = (name) => Number.parseInt(path.basename(name), 10);
  return rank(a) - rank(b) || num(a) - num(b) || a.localeCompare(b);
}

function toReference(node, owner) {
  const out = {};
  let placed = false;
  const place = () => { if (!placed) { out.translatedIn = owner; placed = true; } };

  for (const [key, value] of Object.entries(node)) {
    if (TRANSLATION_KEYS.includes(key) || key === 'translatedIn') continue;
    if (key === 'alternates' || key === 'links') place();
    out[key] = key === 'alternates' && value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([altKey, alt]) => [altKey,
        alt && typeof alt === 'object'
          ? Object.fromEntries(Object.entries(alt).filter(([k]) => !TRANSLATION_KEYS.includes(k)))
          : alt]))
      : value;
    if (key === 'english' || key === 'text') place();
  }
  place();
  return out;
}

/**
 * files: Map of "dialogues/12.json" | "additional-dialogues/30-71.json" -> parsed dialogue.
 * Returns { removed: [{ name, containedIn }], changed: Map name -> new dialogue, stats }.
 * Only additional-dialogues entries are ever removed or changed.
 */
export function dedupe(files) {
  const names = [...files.keys()].sort(fileOrder);
  const ids = new Map(names.map((name) => [name, articyIds(files.get(name))]));
  const isAdditional = (name) => name.startsWith('additional-dialogues/');

  // 1. files fully contained in another single file
  const removed = [];
  const alive = new Set(names);
  for (const name of names.filter(isAdditional)) {
    const mine = ids.get(name);
    if (mine.size === 0) continue;
    const container = names.find((other) => other !== name && alive.has(other)
      && isSubset(mine, ids.get(other))
      && (mine.size < ids.get(other).size || fileOrder(other, name) < 0));
    if (container) {
      removed.push({ name, containedIn: container });
      alive.delete(name);
    }
  }

  // 2. one owner per line: the first remaining file where it isn't already a reference
  const owner = new Map();
  for (const name of names.filter((n) => alive.has(n))) {
    walk(files.get(name).dialogueTree, (node) => {
      if (!isReference(node) && !owner.has(node.articyId)) owner.set(node.articyId, name);
    });
  }

  const changed = new Map();
  let references = 0;
  for (const name of names.filter((n) => alive.has(n) && isAdditional(n))) {
    const dialogue = files.get(name);
    let fileChanged = false;
    const rewrite = (nodes) => (nodes || []).map((node) => {
      let out = node;
      const lineOwner = owner.get(node.articyId);
      if (lineOwner === undefined) {
        throw new Error(`${name}: line ${node.articyId} (node ${node.id}) has no file that translates it`);
      }
      if (lineOwner !== name) {
        if (!isReference(node) || node.translatedIn !== lineOwner) {
          out = toReference(node, lineOwner);
          fileChanged = true;
        }
        references++;
      }
      return Array.isArray(node.links) ? { ...out, links: rewrite(node.links) } : out;
    });
    const dialogueTree = rewrite(dialogue.dialogueTree);
    if (fileChanged) changed.set(name, { ...dialogue, dialogueTree });
  }

  return { removed, changed, stats: { files: names.length, references } };
}

export function readDialogueFiles(textDir) {
  const files = new Map();
  for (const folder of ['dialogues', 'additional-dialogues']) {
    const dir = path.join(textDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      files.set(`${folder}/${name}`, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    }
  }
  return files;
}

// Writes the result of dedupe() back to textDir, keeping each file's line endings.
export function applyDedupe(textDir, result) {
  for (const { name } of result.removed) fs.unlinkSync(path.join(textDir, name));
  for (const [name, dialogue] of result.changed) {
    const filePath = path.join(textDir, name);
    const raw = fs.readFileSync(filePath, 'utf8');
    const newline = raw.includes('\r\n') ? '\r\n' : '\n';
    const trailing = /\r?\n$/.test(raw) ? newline : '';
    fs.writeFileSync(filePath, JSON.stringify(dialogue, null, 2).replace(/\n/g, newline) + trailing, 'utf8');
  }
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const textDir = path.join(root, 'text');
  const result = dedupe(readDialogueFiles(textDir));

  for (const { name, containedIn } of result.removed) console.log(`remove ${name} (every line is also in ${containedIn})`);
  for (const name of result.changed.keys()) console.log(`update ${name}`);
  console.log(`${result.removed.length} file(s) to remove, ${result.changed.size} to update, ${result.stats.references} context-only line(s) in total.`);

  if (dryRun || (result.removed.length === 0 && result.changed.size === 0)) return;
  applyDedupe(textDir, result);
  console.log('Done. Verify with: node tools/text-translation/integrity-checkers/check-dialogues-dedupe.mjs');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
