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
npm run convert-format -- --dry-run   # list what would be converted
npm run convert-format                # convert + check
```

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
