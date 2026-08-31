# UI text bug fixes — reminder / reference

Three separate UI text bugs, what actually caused each one, and where the fix lives.
Written after a long investigation (2026-08-31) where several plausible-looking fixes
turned out to be wrong. Read the "ruled out" notes before re-chasing an old theory.

---

## 1. Delete button (Save/Load screen)

**Symptom:** the delete-game button's text rendered as unreadable single characters
stacked vertically, overflowing the screen.

**Root cause:** the button's `RectTransform` had `m_SizeDelta = (0, 0)` — a "point
anchor" with zero actual size. TextMeshPro responds to this by wrapping *every single
character* onto its own line, regardless of word-wrap settings. This is a general
Unity/TMP gotcha, not specific to this button — any zero-size text box can do this.

**Fix:** `asset-overrides/DeleteGameButtonTextRect-level2-15409.json`
```json
{ "$fieldPatch": { "m_Pivot.x": 1.0, "m_SizeDelta.x": 480.0 } }
```
Gives the box a real width (480) and anchors the pivot to the right edge so it grows
leftward without shifting position.

**If this ever breaks again:** look for `m_SizeDelta = (0, 0)` on the text's own
RectTransform first — it's a five-minute fix once spotted, easy to miss otherwise.

---

## 2. Dice labels ("ЗАЎЖДЫ ПРАВАЛ" / "ЗАЎЖДЫ ПОСПЕХ" — always loses/wins widget)

**Symptom:** garbled, oversized text that mid-word-wrapped ("ЗАЎЖ" / "ДЫ" / "ПРАВ"),
with the dice icons squeezed tiny next to it. This had worked fine for about a year,
then started reproducing 100% of the time after a Disco Elysium game update.

**Root cause: a stale cross-file `m_Script` reference silently mistyping the font.**
The font this widget uses ("Dobra-Book SDF") has a direct copy living inside
`sharedassets1.assets` (Unity duplicates fonts across containers on its own — this
isn't something the mod did). That copy's override file
(`font-assets/output/sharedassets1/Dobra-Book SDF-sharedassets1.assets-9785.json`) does
a **full object replacement**, not a field patch — and it had an `m_Script` PPtr baked
in from whenever it was originally exported, pointing at pathId `2870` in
`globalgamemanagers.assets`. That pathId used to mean `TMP_FontAsset`. A game update
recompiled/reordered the script assembly and pathId `2870` now means something
completely unrelated (`CanvasSampleOpenFileTextMultiple`). Every other field (glyph
table, face metrics, everything) was correct — the game was just loading the object
with the **wrong C# type identity** on every single launch, which is why it was 100%
reproducible and why static field-by-field inspection never caught it.

**Fix:** corrected `m_Script.m_PathID` from `2870` to `2871` (verified `2871` really
resolves to `TMP_FontAsset` via `dump-monob globalgamemanagers.assets 2871`) in that one
JSON file.

**If this ever breaks again after a future game update:** for *any* override that does a
full JSON replacement with a cross-file `m_Script` (`m_FileID != 0`), check that its
class name still resolves correctly:
```
dotnet run --project tools/asset-importer -- dump-monob globalgamemanagers.assets <pathId> 1
```
Look for `m_ClassName` — if it's not the class you expect, that's this bug again.
Bundle-hosted fonts reference their own MonoScript in the *same* bundle (`m_FileID=0`)
and aren't affected by this specific mechanism.

**Dead ends — tried and confirmed unnecessary, don't redo without new evidence:**
- Removing `SpecialFontHandler` from the dice-text GameObjects (12 `$removeComponents`
  overrides) — purpose never fully understood, removal had no measurable effect once the
  real fix landed.
- Stabilizing `WhiteOpen`/`TutoTexts` layout width (`m_ChildControlWidth=0` +
  explicit `m_SizeDelta`) — theorized as a Unity multi-pass-layout-convergence timing
  issue; ruled out because a real timing bug would also occasionally hit vanilla
  players, and it never has.
- Twelve `AlwaysLosesText*`/`AlwaysWinsText*` `$fieldPatch` overrides forcing
  `m_fontSize` from a vanilla `14` (or `46.25` on two "Variant"-suffixed instances) down
  to a flat `12` — tested removed entirely, vanilla sizing works fine now.

---

## 3. Probability label ("ВЕЛЬМІ НІЗКІЯ" + "3%" — the tier/odds text)

This one had **two independent bugs** stacked on top of each other.

### 3a. Wrong font entirely (oversized/garbled)

**Root cause:** this text ("Probability Text", 3 instances: `level2` pathId
`2255`/`19425`, `sharedassets1.assets` pathId `2893`/`14645` and `659`/`11496`) uses a
font called "SinaNova-Medium SDF". Like Dobra-Book SDF above, Unity had duplicated it —
a bundle copy (already Cyrillic-patched, fine) and a **direct copy inside
`sharedassets1.assets` at pathId `9790` that had never been touched — zero Cyrillic
glyphs at all.** Any Cyrillic character sent through it fell through TextMeshPro's
fallback-font chain all the way out to a font meant for Japanese
(`Settings ShipporiMincho-Medium SDF`, in `sharedassets0.assets`) with a wildly
different scale (`m_PointSize` 33 vs. the intended font's 87) — hence oversized,
garbled rendering.

**Fix:** a new override mechanism, `$cloneFontFrom`
(`asset-overrides/SinaNova-Medium SDF-sharedassets1.assets-9790.json`) — copies the
glyph/character table and face metrics from the already-patched bundle copy into this
direct copy, while leaving every container-specific reference (`m_Script`, `material`,
fallback table, the atlas texture's own PPtr) untouched, and overwrites its atlas
texture with the same replacement PNG. See `tools/asset-importer/Program.cs` for the
implementation if a similar "same font, unpatched duplicate copy" bug shows up
elsewhere — use `find-monob-everywhere "<font name>"` to check every copy of a font
across the whole game.

Also: vanilla word-wrap was **off** on all three instances (sized for shorter
Spanish/English phrasing) — turned on via plain `$fieldPatch` overrides
(`ProbabilityTierText-level2-19425.json`, `...-sharedassets1.assets-11496.json`,
`ProbabilityTierTextVariant-...-14645.json`).

### 3b. Font size ignored no matter what you set it to

**Symptom:** even after 3a was fixed, setting `m_fontSize` directly on the TMP
component (to 30, then even an extreme diagnostic value of 15) had **zero visible
effect in-game**, despite being verified byte-correct on disk after a full rebuild and
a full game restart.

**Root cause: a second, different I2 runtime-override mechanism.** A sibling
`LocalizeFontSize` component on the same GameObject carries a `translationList` array —
`{language, fontSize}` pairs for `en`, `es`, `ru`, `pl`, etc. — and I2 Localization
force-applies the entry matching the *active* language on every load, silently
overwriting whatever the TMP component's own `m_fontSize` says. This mod hijacks the
`es` (Spanish) slot, and vanilla's `es` entry was `46`. (An earlier note had dismissed
this component as "empty" — that was never actually verified by dumping its full
contents, only assumed from a shallow look.)

**How this was found:** rather than keep guessing which of the 3 duplicate text objects
is "really" the live one, found the actual game-code controller class (`CheckAdvisor`)
via decompiling `GameAssembly.dll` (Ghidra + Il2CppInspectorRedux, see tool doc below),
and read its own `[SerializeField] probabilityText` reference directly — which
unambiguously names the true live TMP object per instance, no guessing needed.

**Fix:** a new override directive, `$langFontSizePatch`
(`{"$langFontSizePatch": {"es": 32}}`), finds the `translationList` entry by its
`language` field (arrays can't be indexed by the generic `$fieldPatch` dotted-path
mechanism) and sets `fontSize` there. Applied to all three `LocalizeFontSize`
instances: `LocalizeFontSize-level2-28828.json`,
`LocalizeFontSize-sharedassets1.assets-10870.json`,
`LocalizeFontSize-sharedassets1.assets-13010.json`.

**Why `32` specifically:** there are 5 possible tier phrases (CERTAIN, LIKELY, EVEN,
UNLIKELY, IMPOSSIBLE odds). Computed the actual rendered width of each from the font's
own glyph advance-width data (not guessed) — `"ВЕЛЬМІ ВЫСОКІЯ"` (certain/very-high) is
the widest at ~727 font-design-units vs. ~620 for `"ВЕЛЬМІ НІЗКІЯ"` (the one usually
seen in testing). The text box is `260px` wide. `32` is the largest size that keeps even
the widest phrase within the box with a small safety margin — bigger than the previous
`30`, but not guessed. If a future translation change makes any tier phrase longer,
recompute this the same way:
```js
// widthOf(phrase) sums glyph m_Metrics.m_HorizontalAdvance for each character,
// looked up via m_CharacterTable -> m_GlyphTable in the font's own JSON
// (see chat history 2026-08-31 for the exact script)
// then: maxFontSize = boxWidthPx * faceInfo.m_PointSize / (widestPhraseUnits * faceInfo.m_Scale)
```

**If a font-size fix ever shows zero effect again despite correct data on disk:** check
for a `LocalizeFontSize` sibling component and dump its *full* `translationList` (not
just glance at whether it looks short) for an entry matching whatever language slot
this mod hijacks.

---

## Tools added along the way (all in `tools/asset-importer/Program.cs`)

- `dump-monob <file> <pathId> [depth]` / `dump-monob-bundle <bundleEntry> <pathId>` —
  dump any asset by pathId directly, no GameObject assumption (unlike `dump-object`,
  which crashes on a non-GameObject pathId).
- `find-monob-everywhere <name>` — find every copy of a MonoBehaviour-typed asset (font
  assets, etc.) by name, across every direct file *and* every bundle.
- `find-script-users <scriptFile> <className> <targetFile>` — resolve a MonoScript's
  pathId by class name and list every live instance of that class in a target file. Use
  this whenever you can't tell which of several duplicate objects is actually rendered.
- `list-deps <file>` — list a direct file's external dependency table (what `m_FileID`
  indices resolve to).
- `patch-lang-fontsize <file> <pathId>:<lang>=<size> [more...]` — live-test a
  `LocalizeFontSize` entry before committing it to an override.
- Override directives: `$fieldPatch`, `$removeComponents`, `$cloneFontFrom`,
  `$langFontSizePatch` — see comments above each dispatch block in `PatchAsset` in
  `Program.cs` for exact semantics.

## One environmental gotcha worth remembering

The tool's `-original` pristine backups (created once per file, then reused forever)
are **not** touched by a Steam "verify/reset" of the game — they're extra files outside
the game's own manifest. If the game is ever reset to vanilla, delete every
`*-original` file in the game's Data folder and bundle subfolders *before* the next
`npm run import-assets`, or the pipeline will silently rebuild on top of a stale
baseline instead of the fresh reset.
