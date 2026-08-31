# UI text bug fixes — reminder / reference

Five separate UI text bugs, what actually caused each one, and where the fix lives.
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

## 4. Ability-adjustment title bar ("ДАПАСУЙ ЗДОЛЬНАСЦІ:" — character sheet screen)

**Symptom:** the white title-bar background behind the header text was sized for the
original (shorter) text. With few "ability points" left to spend, the header wrapped to
two lines inside a box only tall/wide enough for one; with more points left, the header
overlapped the row of small progress dots ("pips") next to it.

**Root cause:** the controlling script, `CharacterCreationTitleBar` (found via the
decompiled `types.cs` — grep for the term key `Abilities/ABILITY_ADJUST_TITLE` in
`LocalizationCustomSystem.cs`, then found the actual view class,
`CharacterCreationAdjustAbilitiesView`, and its sibling `CharacterCreationTitleBar`
script, both on the `Charsheet` GameObject in `level2`), computes the background box's
width with this exact formula (from decompiling `SetAdjustTitle()`):
```
targetWidth = pipCount * pipWidth + AdjustAbilitiesWidth[language] + paddingWidth
```
`pipCount` legitimately varies (more remaining points = more pips shown, box needs to be
wider) — that part isn't a bug. `AdjustAbilitiesWidth` is a **per-language lookup table**
(a `TranslationTestableFloat`: two parallel arrays, `floatValues`/`languagesNames`,
matched by index — not an array of `{language, value}` pairs like `LocalizeFontSize`
above). The vanilla Spanish (`es`) entry was `620`, sized for the original short Spanish
title — nowhere near enough for `"ДАПАСУЙ ЗДОЛЬНАСЦІ:"`.

**Fix:** the `$translationFloatPatch` override directive (matched by the **full language
name**, e.g. `"Spanish"`, not a language code like `"es"`) in
`asset-overrides/CharacterCreationTitleBar-level2-29247.json`:
```json
{
  "$translationFloatPatch": {
    "AdjustAbilitiesWidth": { "Spanish": 685.0 },
    "SetSkillWidth": { "Spanish": 480.0 }
  }
}
```
Same component, same script, two separate title states it switches between
(`SetAdjustTitle()`/`SetSkillTitle()` — this screen shows `"АБЯРЫ НАВЫК"` when picking a
*signature skill*, a different header than `"ДАПАСУЙ ЗДОЛЬНАСЦІ:"`). If a third title
state on this same component ever turns up with the same box-sizing symptom, it's
almost certainly a third `TranslationTestableFloat` field on `CharacterCreationTitleBar`
needing the same treatment — check the class's field list in the decompiled `types.cs`
first.

**Why `685`/`480` specifically:** computed each string's actual rendered text width via
the font's own glyph data (`measure-text` command — `~695px` for
`"ДАПАСУЙ ЗДОЛЬНАСЦІ:"` (missing one glyph, see below), `~445px` for
`"АБЯРЫ НАВЫК"`), then live-tested starting a bit above the raw estimate and tightened
based on the actual on-screen gap between the text and the pips (`720` for the first one
left visibly too much dead space before the pips started, since they begin at the *end*
of the `AdjustAbilitiesWidth`-sized region regardless of how much of it the text actually
fills) — landed on `660`, then bumped to `685` for a bit more clearance during the
title-bar's slide-in animation, where it can clip slightly tighter than the settled
state. Confirmed correct in-game for both title states in the settled state; the
animation transition has a very minor, split-second visual glitch even at `685` that
wasn't worth chasing further (see `textTweenDuration`/`backgroundTweenDuration` in
`CharacterCreationTitleBar` if this needs revisiting — the tween might not be perfectly
synced between the text and background regardless of the width value).

---

## 5. Thought Cabinet slot names (thought names overflowing their diamond icons)

**Symptom:** thought names in the Thought Cabinet grid overflowed way outside their
diamond-shaped slot icons — sometimes bleeding into the row above, sometimes into the
character portrait below. Reducing the font size on the object that *looked* relevant
had zero visible effect, repeatedly, even after a full restart.

**Root cause, part 1 — five more unpatched duplicate-font copies.** The text itself is
rendered via `ThoughtSlot._thoughtNameText`. Investigating this font turned into a
proactive sweep of the whole cluster of direct-file font copies in `sharedassets1.assets`
(pathIds `9783`-`9793`, found via `dump-monob sharedassets1.assets <pathId> 1` across the
range) — the same duplicate-font problem as `SinaNova-Medium SDF` in bug #3 turned out to
affect **five more** fonts that had never been checked individually: `CoreSansES Light`,
`Dobra-Bold`, `Dobra-Light`, `Dobra-Medium`, `SinaNova-Bold`. All five had zero Cyrillic
glyphs in their direct copies while their bundle-hosted twins were correctly patched.
Fixed the same way, one `$cloneFontFrom` override per font
(`asset-overrides/<FontName>-sharedassets1.assets-<pathId>.json`). **If a future font
bug looks like this pattern, check the entire pathId cluster around a known font
directly** rather than one font at a time — `font-mapping.json` lists every font this
mod manages; any of them could have an unpatched direct-file twin nobody's found yet.

**Root cause, part 2 — editing the wrong prefab entirely, twice.** `ThoughtSlot` exists
as **two separate prefab templates** (not per-instance duplicates like the dice widget in
bug #2 — actual reusable prefabs, instantiated at runtime): `sharedassets1.assets`
pathId `1564` ("`THC_SlotPrefab`", `fontSize=36`) and `sharedassets2.assets` pathId
`1853` ("`Thought SlotPrefab`", `fontSize=18`, `m_fontAsset` **null**). Guessing by name
and visual plausibility (the bigger `fontSize=36` "looked more consistent" with the
screenshot), the wrong one was edited and tested twice with zero effect. The actual live
one was found the reliable way — via the spawner's own reference,
`ThoughtSlotsTree.slotPrefab` (a `[SerializeField] ThoughtSlot` field on the singleton
found by `find-script-users globalgamemanagers.assets ThoughtSlotsTree "*"`, live
instance in `level2`) — which pointed to the `sharedassets2.assets` copy. **Always
resolve "which of several duplicate objects is actually live" via the spawner/controller
script's own SerializeField reference, never by name or visual guessing** — this is now
the third time in this investigation a guess-by-name turned out wrong (see bug #3's
`Probability Text` mislabeling, and this).

**Root cause, part 3 — a null font asset resolves through a mechanism edits can't see.**
Even after finding the *correct* prefab, changing its `m_fontSize` still had zero visible
effect. Its `m_fontAsset` PPtr is `(0, 0)` — **null** — so TextMeshPro falls back to
`TMP_Settings.m_defaultFontAsset`, which is *also* null, meaning TMP resolves the actual
font via `Resources.Load(TMP_Settings.m_defaultFontAssetPath + "LiberationSans SDF")` at
runtime — a Unity Resources-folder lookup, not a direct asset reference our tooling can
just edit and expect to see used. Also worth remembering: this file
(`sharedassets2.assets`) had never been touched by this pipeline before, so its
`-original` pristine backup was still the **2-day-stale one from before the game reset**
(see the environmental gotcha at the bottom of this doc) — a second, compounding reason
edits weren't landing as expected. Deleted the stale backup, then **sidestepped the
whole null-default-resolution mystery** by explicitly assigning a known-good, already
Cyrillic-patched font asset (`Dobra-Medium SDF`, `sharedassets1.assets` pathId `9787`,
cross-file `m_FileID=6`) directly to `m_fontAsset`, rather than trying to figure out
which physical asset `Resources.Load` was actually resolving to.

**Fix:** `asset-overrides/ThoughtSlotPrefab-sharedassets2.assets-3312.json`:
```json
{
  "$fieldPatch": {
    "m_fontAsset.m_FileID": 6,
    "m_fontAsset.m_PathID": 9787,
    "m_fontSize": 16.0,
    "m_fontSizeBase": 16.0
  }
}
```
`16` was reached empirically: `13` fixed the overflow entirely (confirming the fix) but
looked too small; `16` was confirmed comfortable with no overflow returning.

**If a TMP component's font/size edit has zero effect and `m_fontAsset` is `(0, 0)`:**
that's this exact mechanism — don't try to edit `TMP_Settings.m_defaultFontAsset`
globally (affects every default-font TMP object project-wide, way outside this mod's
intended blast radius); assign an explicit, already-patched font directly to the
specific component instead.

**Side-finding, not yet acted on:** the font used here (`LiberationSans SDF`,
`resources.assets` pathId `2988` — TMP's own stock default font, confirmed *not* one of
this mod's managed fonts, not in `font-mapping.json`) is **missing the glyph for `І`**
(U+0406, the Belarusian dotted-I, distinct from Cyrillic `И`/Latin `I`). It's rendering
via TMP's fallback chain currently without an obvious visual problem, but if a similar
"garbled/wrong-scale fallback" bug ever shows up on text using this font, check this
first — see the `Dobra-Book`/`SinaNova` fallback-chain bug in bug #3 above for what that
looks like when it goes wrong.

**If a UI box's size is wrong for translated text despite the *text itself* being
correct:** check for a `TranslationTestableFloat`-typed field on a nearby MonoBehaviour
(not just `LocalizeFontSize` — any per-language "testable" value is suspect) before
assuming it's a plain layout/wrap bug like bug #1's zero-size RectTransform.

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
- `find-term-everywhere <termSubstring>` — structurally scan every direct file *and*
  bundle for a `Localize` component whose `mTerm` contains the substring. If this comes
  back with 0 hits for a term you know is used somewhere, the text is being set by code
  directly (see `find-script-users` below), not a static `Localize` component.
- `measure-text <file> <fontAssetPathId> <fontSize> <text>` — compute a string's actual
  rendered pixel width from a live font asset's own glyph advance-width data, for sizing
  a box to fit a specific translated string precisely instead of guessing.
- `patch-lang-fontsize <file> <pathId>:<lang>=<size> [more...]` — live-test a
  `LocalizeFontSize` entry before committing it to an override.
- `patch-translation-float <file> <pathId>:<field>:<langName>=<value> [more...]` —
  live-test a `TranslationTestableFloat` entry (matched by full language name, e.g.
  `Spanish`) before committing it to an override.
- Override directives: `$fieldPatch`, `$removeComponents`, `$cloneFontFrom`,
  `$langFontSizePatch`, `$translationFloatPatch` — see comments above each dispatch
  block in `PatchAsset` in `Program.cs` for exact semantics.

**Batching gotcha that bit twice this session:** every one of the live-test commands
above (`patch-field`, `patch-lang-fontsize`, `patch-translation-float`,
`remove-and-patch`) rebuilds its target file from that file's `-original` pristine
backup on *every call* — it does not layer onto whatever the previous call just wrote.
Multiple edits to the *same file* must go in one call (all these commands accept
multiple `pathId:...` tokens for exactly this reason) or the second call's rebuild
silently erases the first call's change. Calling one of these commands with **zero**
edit arguments by mistake rebuilds the file from pristine with *no* changes at all,
instantly reverting every tracked fix in that file back to vanilla until the next
`npm run import-assets` — always double-check the command actually has its edit
arguments before running it, and re-run the full pipeline immediately if in doubt.

## One environmental gotcha worth remembering

The tool's `-original` pristine backups (created once per file, then reused forever)
are **not** touched by a Steam "verify/reset" of the game — they're extra files outside
the game's own manifest. If the game is ever reset to vanilla, delete every
`*-original` file in the game's Data folder and bundle subfolders *before* the next
`npm run import-assets`, or the pipeline will silently rebuild on top of a stale
baseline instead of the fresh reset.
