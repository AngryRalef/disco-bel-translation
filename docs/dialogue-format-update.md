# New dialogue format — reminder / reference

On 2026-09-28 dialogue files got a shorter, more readable format. To avoid conflicts with
work in progress, **only dialogues nobody had taken were converted** (open issue, no
assignee). Files that were assigned or closed at that time still use the old format, and
both formats work with every tool (packing, fixers, progress report, translation assistant).

---

## What changed

Before:
```json
{
  "id": 185,
  "redacted": false,
  "title": "Horseback Monument: \"A cardboard sign hangs...\"",
  "actor": "Horseback Monument",
  "to": null,
  "articyId": "0x0100000F00014DAE",
  "english": "...",
  "polish": "...",
  "belarusian": "...",
  "links": []
}
```

After:
```json
{
  "id": 185,
  "articyId": "0x0100000F00014DAE",
  "speaker": "Horseback Monument -> N/A",
  "english": "...",
  "polish": "...",
  "belarusian": "...",
  "links": []
}
```

- `title` and `redacted` are removed (`redacted` is still kept in
  `text/translated/dialogues-translated.json`).
- `actor` and `to` are merged into `speaker`: `"<who speaks> -> <to whom>"`. `N/A`
  means the game data has no value there.
- `id` and `articyId` come first. **Don't edit them**, the packing script needs them.
- `english`, `polish`, `belarusian` and `alternates` are exactly as before.

---

## Context-only lines (`translatedIn`)

Some additional dialogues are different ways into the same conversation, so they used to
contain the same lines, each translated differently, while the game can only use one text
per line. Now every line is translated in exactly one file. Where another file passes
through the same lines, they're still there so you can follow the conversation, but
without `polish`/`belarusian`:
```json
{
  "id": 77,
  "articyId": "0x01000007000149D3",
  "speaker": "The Pigs -> You",
  "english": "The gun lands on the wooden planks and tears run down her scratched cheeks. ...",
  "translatedIn": "additional-dialogues/60-280.json",
  "links": [ ... ]
}
```
Nothing to translate there. To change that line, edit it in the file named in
`translatedIn`. **Don't add `belarusian` to a context-only line**: packing stops with an
error if the same line has two different translations.

Five files that were entirely contained in another file were removed on 2026-09-28:
`30-71` (all of it is in `33-71`), `334-806` and `335-806` (in `333-806`), `338-810` (in
`339-810`), `342-814` (in `343-814`).

Tools: `npm run dedupe-dialogues` (safe to repeat) and `npm run check-dialogues-dedupe`.
The unpacking script applies the same rule automatically.

---

## If you're translating a dialogue right now

Nothing to do. Your file wasn't touched, so keep working and merge as usual.

---

## Converting the remaining files later

Always convert on an up-to-date branch **after** the dialogue's work is merged, and commit
your changes first: the check compares against the last commit, so uncommitted edits
would show up as "changed".

**Everything that's untaken right now** (same rule as the translation assistant, run from
the disco-translation-assistant repo):
```
npm run convert-format -- --dry-run          # list what would be converted
npm run convert-format                       # convert + check
npm run convert-format -- --include-closed   # also finished dialogues (closed issue)
```
It never touches assigned dialogues, and it skips files that an open pull request changes,
or that changed on `main` since your branch split off (merge `main` first, then re-run).

**Specific finished dialogues** (from this repo's root):
```
npm run convert-dialogues -- text/dialogues/17.json text/dialogues/38.json
npm run check-dialogues-conversion -- text/dialogues/17.json text/dialogues/38.json
```

The check must end with `OK: no content lost or changed.` If it says `FAILED`, **don't
commit**: undo with `git checkout -- text/`.

Converting is safe to repeat. Files that are already converted are left unchanged.

---

## Notes

- To check against something other than your last commit, pass a git ref:
  `npm run check-dialogues-conversion -- --before <branch-or-commit>`.
- Without file names, the check covers every dialogue file and also requires all of them
  to be in the new format. While some are still in the old format, run it with
  `--no-format-check` to only compare content.
- If someone does convert a file on their own branch while it's being worked on, the same
  two commands work there too. Commit your work first, then convert and check.
