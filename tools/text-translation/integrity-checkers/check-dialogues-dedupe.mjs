/**
 * check-dialogues-dedupe.mjs
 *
 * Strict check that every dialogue line is translatable in exactly one file, and (against a
 * git ref) that converters/dedupe-additional-dialogues.mjs lost nothing. Written separately
 * from the dedupe script so a bug in one can't hide itself in the other.
 *
 * Usage (from anywhere):
 *   node tools/text-translation/integrity-checkers/check-dialogues-dedupe.mjs [--before <git-ref>] [--current-only]
 *
 *   --before        git ref with the state before deduplication (default: HEAD)
 *   --current-only  only check the working tree's own rules, no before/after comparison
 *
 * Rules for the working tree:
 *   - a line (or alternate) has "belarusian" in at most one file
 *   - a context-only node ("translatedIn") has no polish/belarusian, points to a file that
 *     really translates that line, and shows the same english/speaker/alternates as it
 * Rules against --before:
 *   - text/dialogues is completely unchanged
 *   - only files whose every line still exists elsewhere were deleted; no new files
 *   - every remaining file has exactly the same tree (nodes, order, nesting); a node either
 *     stayed identical, or became context-only (polish/belarusian removed, translatedIn added)
 *   - every line and alternate that had a translation before still has one after, and the
 *     translating file kept its own text unchanged
 * Exits with code 1 on any problem.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const folders = ['dialogues', 'additional-dialogues'];

function parseArgs(argv) {
  const args = { before: 'HEAD', currentOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--before') args.before = argv[++i];
    else if (argv[i] === '--current-only') args.currentOnly = true;
  }
  return args;
}

function readAtRef(ref) {
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
  const entries = git(['ls-tree', '-r', ref, '--', ...folders.map((f) => `text/${f}`)]).toString('utf8')
    .split('\n').filter((l) => l.endsWith('.json'))
    .map((line) => { const [meta, p] = line.split('\t'); return { blob: meta.split(' ')[2], name: p.replace(/^text\//, '') }; });
  const out = git(['cat-file', '--batch'], entries.map((e) => e.blob).join('\n') + '\n');
  const files = new Map();
  let offset = 0;
  for (const { name } of entries) {
    const headerEnd = out.indexOf(10, offset);
    const size = Number(out.toString('utf8', offset, headerEnd).split(' ')[2]);
    files.set(name, JSON.parse(out.toString('utf8', headerEnd + 1, headerEnd + 1 + size)));
    offset = headerEnd + 1 + size + 1;
  }
  return files;
}

function readWorkingTree() {
  const files = new Map();
  for (const folder of folders) {
    const dir = path.join(root, 'text', folder);
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      files.set(`${folder}/${n}`, JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
    }
  }
  return files;
}

const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}

function nodesOf(dialogue) {
  const list = [];
  const walk = (nodes) => { for (const n of nodes || []) { list.push(n); walk(n.links); } };
  walk(dialogue.dialogueTree);
  return list;
}

// Every translated text in a file: "Dialogue Text/<articyId>" and "<AlternateN>/<articyId>"
function translations(dialogue) {
  const map = new Map();
  for (const n of nodesOf(dialogue)) {
    if (typeof n.belarusian === 'string') map.set(`Dialogue Text/${n.articyId}`, n.belarusian);
    if (n.alternates && typeof n.alternates === 'object') {
      for (const [k, alt] of Object.entries(n.alternates)) {
        if (alt && typeof alt.belarusian === 'string') map.set(`${k}/${n.articyId}`, alt.belarusian);
      }
    }
  }
  return map;
}

function withoutTranslation(node) {
  const { polish, belarusian, translatedIn, links, ...rest } = node;
  if (rest.alternates && typeof rest.alternates === 'object') {
    rest.alternates = Object.fromEntries(Object.entries(rest.alternates).map(([k, alt]) => {
      if (!alt || typeof alt !== 'object') return [k, alt];
      const { polish: p, belarusian: b, ...altRest } = alt;
      return [k, altRest];
    }));
  }
  return rest;
}

function checkCurrent(files, errors) {
  const owners = new Map(); // key -> file
  for (const [name, dialogue] of files) {
    for (const key of translations(dialogue).keys()) {
      if (owners.has(key)) errors.push(`${key} is translated in both ${owners.get(key)} and ${name}`);
      else owners.set(key, name);
    }
  }

  let references = 0;
  const byFileAndId = new Map();
  for (const [name, dialogue] of files) {
    for (const n of nodesOf(dialogue)) if (typeof n.translatedIn !== 'string') byFileAndId.set(`${name}|${n.articyId}`, n);
  }
  for (const [name, dialogue] of files) {
    for (const n of nodesOf(dialogue)) {
      if (!('translatedIn' in n)) continue;
      references++;
      const at = `${name} node ${n.id}`;
      if (typeof n.translatedIn !== 'string') { errors.push(`${at}: translatedIn is not a string`); continue; }
      if (n.translatedIn === name) errors.push(`${at}: points to its own file`);
      const keys = Object.keys(n);
      const anchor = keys.includes('english') ? 'english' : 'text';
      if (keys.includes(anchor) && keys.indexOf('translatedIn') !== keys.indexOf(anchor) + 1) errors.push(`${at}: translatedIn should come right after ${anchor}`);
      if ('polish' in n || 'belarusian' in n) errors.push(`${at}: context-only node still has polish/belarusian`);
      for (const alt of Object.values(n.alternates || {})) {
        if (alt && typeof alt === 'object' && ('polish' in alt || 'belarusian' in alt)) errors.push(`${at}: context-only alternate still has polish/belarusian`);
      }
      const target = byFileAndId.get(`${n.translatedIn}|${n.articyId}`);
      if (!target) { errors.push(`${at}: ${n.translatedIn} doesn't translate ${n.articyId}`); continue; }
      if (!same(withoutTranslation(n), withoutTranslation(target))) errors.push(`${at}: english/speaker/alternates differ from ${n.translatedIn}`);
    }
  }
  return { owners, references };
}

// Format-independent view of a node (old actor/to/title/redacted vs new speaker), so this
// check also works while the separate format conversion isn't committed yet.
function canonical(node) {
  const { title, redacted, actor, to, links, ...rest } = node;
  if (actor !== undefined || to !== undefined) rest.speaker = `${actor ?? "N/A"} -> ${to ?? "N/A"}`;
  return rest;
}

function compareTree(beforeNodes, afterNodes, where, errors, stats) {
  if ((beforeNodes || []).length !== (afterNodes || []).length) {
    errors.push(`${where}: ${(beforeNodes || []).length} nodes before, ${(afterNodes || []).length} after`);
    return;
  }
  for (let i = 0; i < (beforeNodes || []).length; i++) {
    const b = canonical(beforeNodes[i]);
    const a = canonical(afterNodes[i]);
    const at = `${where}[${i}](id ${b.id})`;
    if ("translatedIn" in a && !("translatedIn" in b)) {
      if (!same(withoutTranslation(b), withoutTranslation(a))) errors.push(`${at}: became context-only but other fields changed`);
      stats.madeContextOnly++;
    } else if (!same(b, a)) {
      errors.push(`${at}: node changed`);
    }
    compareTree(beforeNodes[i].links, afterNodes[i].links, `${at}.links`, errors, stats);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const after = readWorkingTree();
  const { owners, references } = checkCurrent(after, errors);

  console.log(`Working tree: ${after.size} files, ${owners.size} translated lines/alternates, ${references} context-only lines.`);

  if (!args.currentOnly) {
    const before = readAtRef(args.before);
    const stats = { madeContextOnly: 0, removed: [], discarded: 0 };

    for (const name of after.keys()) if (!before.has(name)) errors.push(`${name}: new file, not present at ${args.before}`);

    const beforeKeys = new Map(); // key -> Set of texts
    for (const [name, dialogue] of before) {
      for (const [key, text] of translations(dialogue)) {
        if (!beforeKeys.has(key)) beforeKeys.set(key, new Set());
        beforeKeys.get(key).add(text);
      }

      if (name.startsWith('dialogues/')) {
        if (!after.has(name)) errors.push(`${name}: text/dialogues file was deleted`);
        else compareTree(dialogue.dialogueTree, after.get(name).dialogueTree, name, errors, stats);
        continue;
      }
      if (!after.has(name)) {
        stats.removed.push(name);
        for (const n of nodesOf(dialogue)) {
          const stillThere = [...after.values()].some((d) => nodesOf(d).some((x) => x.articyId === n.articyId));
          if (!stillThere) errors.push(`${name} was deleted but its line ${n.articyId} exists nowhere else`);
        }
        continue;
      }
      const { dialogueTree: bt, ...bTop } = dialogue;
      const { dialogueTree: at, ...aTop } = after.get(name);
      if (!same(bTop, aTop)) errors.push(`${name}: file-level fields changed`);
      compareTree(bt, at, `${name}`, errors, stats);
    }

    for (const [key, texts] of beforeKeys) {
      if (!owners.has(key)) errors.push(`${key} had a translation before, but none after`);
      else if (!texts.has(translations(after.get(owners.get(key))).get(key))) errors.push(`${key}: translation after isn't one of the texts it had before`);
      if (texts.size > 1) stats.discarded += texts.size - 1;
    }
    if (owners.size !== beforeKeys.size) errors.push(`${beforeKeys.size} translated lines/alternates before, ${owners.size} after`);

    console.log(`Before (${args.before}): ${before.size} files, ${beforeKeys.size} translated lines/alternates.`);
    console.log(`  files removed:             ${stats.removed.length} ${stats.removed.join(', ')}`);
    console.log(`  nodes made context-only:   ${stats.madeContextOnly}`);
    console.log(`  duplicate versions dropped: ${stats.discarded}`);
  }

  if (errors.length) {
    console.error(`\nFAILED: ${errors.length} problem(s):`);
    for (const e of errors.slice(0, 200)) console.error(`  ${e}`);
    if (errors.length > 200) console.error(`  ... and ${errors.length - 200} more`);
    process.exit(1);
  }
  console.log('\nOK: every line is translated in exactly one file, nothing lost.');
}

main();
