/**
 * check-dialogues-conversion.mjs
 *
 * Strict before/after check for the dialogue file format conversion
 * (converters/convert-dialogues-format.mjs). Deliberately written independently of the
 * converter, so a bug in one can't hide itself in the other.
 *
 * Usage (from the repo root or anywhere):
 *   node tools/text-translation/integrity-checkers/check-dialogues-conversion.mjs [--before <git-ref>] [--no-format-check] [file ...]
 *
 *   --before           git ref holding the "before" state (default: HEAD)
 *   --no-format-check  only compare content, don't require the working tree to be fully in the new format
 *   file ...           limit the check to these dialogue files (paths like text/dialogues/12.json);
 *                      default: every file in text/dialogues and text/additional-dialogues
 *
 * What must hold for every file, or the script exits with code 1:
 *   - the same files exist before and after
 *   - file-level fields (id, title, description, ...) are identical
 *   - the tree has exactly the same shape: same nodes, same order, same nesting
 *   - every node keeps id, articyId, english, polish, belarusian, text and alternates
 *     exactly (deep-equal), plus any other field not explicitly dropped
 *   - actor/to survive as "speaker": "<actor or N/A> -> <to or N/A>" and parse back
 *     to exactly the original values (N/A <-> null)
 *   - only "title" and "redacted" may disappear from a node
 * Plus corpus-wide totals (nodes, texts, alternates, articyId -> belarusian map used by the
 * packer) are compared, so nothing can go missing even in a way the per-node walk misses.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const folders = ['text/dialogues', 'text/additional-dialogues'];

const DROPPED_KEYS = new Set(['title', 'redacted']);
const NA = 'N/A';
const ARROW = ' -> ';

function parseArgs(argv) {
  const args = { before: 'HEAD', formatCheck: true, files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--before') args.before = argv[++i];
    else if (argv[i] === '--no-format-check') args.formatCheck = false;
    else args.files.push(path.relative(root, path.resolve(argv[i])).replace(/\\/g, '/'));
  }
  return args;
}

function git(args, input) {
  return execFileSync('git', args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
}

// Reads every dialogue file at `ref` in one git call instead of one process per file.
function readFilesAtRef(ref) {
  const listing = git(['ls-tree', '-r', ref, '--', ...folders]).toString('utf8');
  const entries = listing.split('\n').filter(Boolean).map((line) => {
    const [meta, filePath] = line.split('\t');
    return { blob: meta.split(' ')[2], filePath };
  }).filter((e) => e.filePath.endsWith('.json'));

  const output = git(['cat-file', '--batch'], entries.map((e) => e.blob).join('\n') + '\n');
  const files = new Map();
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(10, offset);
    const size = Number(output.toString('utf8', offset, headerEnd).split(' ')[2]);
    const start = headerEnd + 1;
    files.set(entry.filePath, output.toString('utf8', start, start + size));
    offset = start + size + 1;
  }
  return files;
}

function readWorkingTree() {
  const files = new Map();
  for (const folder of folders) {
    const dir = path.join(root, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      files.set(`${folder}/${name}`, fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  return files;
}

// Numbers too large for a JS double would be silently changed by JSON.parse - refuse them.
function assertNoUnsafeNumbers(raw, label, errors) {
  const unsafe = raw.match(/(?<!["\w.])-?\d{16,}(?![\w."])/g);
  if (unsafe) errors.push(`${label}: contains integers too large to round-trip safely: ${unsafe.slice(0, 3).join(', ')}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// Key order is irrelevant for content equality; compare with sorted keys.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}

function speakerPart(value) {
  return value === null ? NA : value;
}

function parseSpeaker(speaker, where, errors) {
  if (typeof speaker !== 'string') {
    errors.push(`${where}: speaker is not a string`);
    return { actor: undefined, to: undefined };
  }
  const parts = speaker.split(ARROW);
  if (parts.length !== 2 || parts.some((p) => p === '')) {
    errors.push(`${where}: speaker "${speaker}" is not "<actor> -> <to>"`);
    return { actor: undefined, to: undefined };
  }
  return { actor: parts[0] === NA ? null : parts[0], to: parts[1] === NA ? null : parts[1] };
}

// Semantic content of a node, independent of which format it is stored in.
function content(node, where, errors) {
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'links' || DROPPED_KEYS.has(key)) continue;
    if (key === 'speaker') {
      Object.assign(out, parseSpeaker(value, where, errors));
      continue;
    }
    out[key] = value;
  }
  if ('speaker' in node && ('actor' in node || 'to' in node)) {
    errors.push(`${where}: has both speaker and actor/to`);
  }
  return out;
}

function checkNewFormat(node, where, errors) {
  const keys = Object.keys(node);
  for (const key of keys) {
    if (DROPPED_KEYS.has(key) || key === 'actor' || key === 'to') errors.push(`${where}: still has old field "${key}"`);
  }
  if (keys[0] !== 'id') errors.push(`${where}: first field is "${keys[0]}", expected "id"`);
  if ('articyId' in node && keys[1] !== 'articyId') errors.push(`${where}: second field is "${keys[1]}", expected "articyId"`);
  if ('links' in node && keys[keys.length - 1] !== 'links') errors.push(`${where}: "links" is not the last field`);
  if ('speaker' in node && keys[2] !== 'speaker') errors.push(`${where}: "speaker" is not the third field`);
}

function compareTrees(beforeNodes, afterNodes, where, errors, stats, formatCheck) {
  if (!Array.isArray(beforeNodes) || !Array.isArray(afterNodes)) {
    if (beforeNodes !== afterNodes) errors.push(`${where}: links is not an array on one side`);
    return;
  }
  if (beforeNodes.length !== afterNodes.length) {
    errors.push(`${where}: ${beforeNodes.length} nodes before, ${afterNodes.length} after`);
    return;
  }
  for (let i = 0; i < beforeNodes.length; i++) {
    const before = beforeNodes[i];
    const after = afterNodes[i];
    const at = `${where}[${i}](id ${before?.id})`;
    if (!isPlainObject(before) || !isPlainObject(after)) {
      errors.push(`${at}: node is not an object`);
      continue;
    }

    const b = content(before, `${at} before`, errors);
    const a = content(after, `${at} after`, errors);
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (!(key in a)) errors.push(`${at}: field "${key}" is missing after conversion`);
      else if (!(key in b)) errors.push(`${at}: unexpected new field "${key}"`);
      else if (!deepEqual(b[key], a[key])) errors.push(`${at}: field "${key}" changed: ${JSON.stringify(b[key])?.slice(0, 120)} -> ${JSON.stringify(a[key])?.slice(0, 120)}`);
    }
    if (formatCheck) checkNewFormat(after, at, errors);

    stats.count(before, 'before');
    stats.count(after, 'after');
    compareTrees(before.links ?? [], after.links ?? [], `${at}.links`, errors, stats, formatCheck);
  }
}

function makeStats() {
  const totals = { before: {}, after: {} };
  const packerMap = { before: new Map(), after: new Map() };
  const add = (side, key, n = 1) => { totals[side][key] = (totals[side][key] || 0) + n; };

  return {
    totals,
    packerMap,
    count(node, side) {
      add(side, 'nodes');
      for (const lang of ['english', 'polish', 'belarusian', 'text']) {
        if (typeof node[lang] === 'string') add(side, `${lang} texts`);
      }
      if (isPlainObject(node.alternates)) {
        for (const alt of Object.values(node.alternates)) {
          add(side, 'alternates');
          if (isPlainObject(alt)) for (const lang of ['english', 'polish', 'belarusian']) {
            if (typeof alt[lang] === 'string') add(side, `alternate ${lang} texts`);
          }
        }
      }
      if ('actor' in node || 'speaker' in node) add(side, 'nodes with speaker info');
      if (node.articyId !== undefined) packerMap[side].set(node.articyId, node.belarusian);
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const stats = makeStats();

  const beforeFiles = readFilesAtRef(args.before);
  const afterFiles = readWorkingTree();
  const only = args.files.length ? new Set(args.files) : null;

  const names = new Set([...beforeFiles.keys(), ...afterFiles.keys()].filter((n) => !only || only.has(n)));
  if (only) for (const f of only) if (!names.has(f)) errors.push(`${f}: not found before or after`);

  for (const name of [...names].sort()) {
    if (!beforeFiles.has(name)) { errors.push(`${name}: new file, not present at ${args.before}`); continue; }
    if (!afterFiles.has(name)) { errors.push(`${name}: file is missing after conversion`); continue; }

    const beforeRaw = beforeFiles.get(name);
    const afterRaw = afterFiles.get(name);
    assertNoUnsafeNumbers(beforeRaw, `${name} before`, errors);
    assertNoUnsafeNumbers(afterRaw, `${name} after`, errors);

    let before, after;
    try { before = JSON.parse(beforeRaw); } catch (e) { errors.push(`${name}: invalid JSON before: ${e.message}`); continue; }
    try { after = JSON.parse(afterRaw); } catch (e) { errors.push(`${name}: invalid JSON after: ${e.message}`); continue; }

    const { dialogueTree: beforeTree, ...beforeTop } = before;
    const { dialogueTree: afterTree, ...afterTop } = after;
    if (!deepEqual(beforeTop, afterTop)) errors.push(`${name}: file-level fields changed`);
    if (JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after))) errors.push(`${name}: file-level field order changed`);

    compareTrees(beforeTree ?? [], afterTree ?? [], `${name} dialogueTree`, errors, stats, args.formatCheck);
  }

  const { totals, packerMap } = stats;
  console.log(`Files checked: ${names.size} (before = ${args.before}, after = working tree)`);
  for (const key of new Set([...Object.keys(totals.before), ...Object.keys(totals.after)])) {
    const b = totals.before[key] || 0;
    const a = totals.after[key] || 0;
    console.log(`  ${key.padEnd(28)} before ${String(b).padStart(7)}   after ${String(a).padStart(7)}${a === b ? '' : '   <-- MISMATCH'}`);
    if (a !== b) errors.push(`total "${key}" differs: ${b} before, ${a} after`);
  }

  // The exact data pack-translations.mjs extracts (articyId -> belarusian) must be unchanged.
  if (packerMap.before.size !== packerMap.after.size) errors.push(`packer map size differs: ${packerMap.before.size} vs ${packerMap.after.size}`);
  for (const [id, value] of packerMap.before) {
    if (packerMap.after.get(id) !== value) errors.push(`packer map: belarusian for ${id} differs`);
  }
  console.log(`  ${'packer articyId -> belarusian'.padEnd(28)} before ${String(packerMap.before.size).padStart(7)}   after ${String(packerMap.after.size).padStart(7)}`);

  if (errors.length) {
    console.error(`\nFAILED: ${errors.length} problem(s):`);
    for (const error of errors.slice(0, 200)) console.error(`  ${error}`);
    if (errors.length > 200) console.error(`  ... and ${errors.length - 200} more`);
    process.exit(1);
  }
  console.log('\nOK: no content lost or changed.');
}

main();
