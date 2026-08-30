// Headlessly imports everything this repo produces as ready-to-ship UABE-style dumps,
// straight into the game's install folder, replacing manual UABEANext GUI reimports:
//  - translated Lockit JSON dumps (text/translated/*.json)
//  - replacement font JSON dumps + atlas PNGs (font-assets/output, font-assets/input)
//  - translated UI texture PNGs (images/translations/Belarusian/*.png)
//  - one-off targeted overrides for anything else (asset-overrides/*.json|*.txt) -
//    bug fixes, but also things like a font size or line-height tweak on one specific
//    asset that doesn't belong in the bulk lockit/font pipelines
//
// Every source file is named "<AssetName>-<container>-<pathId>.<json|txt|png>", the same
// convention UABE itself uses for batch export/import. <container> is either a bundle's
// "CAB-<hash>" entry name, or a literal "<file>.assets" naming a data file directly in
// the game's *_Data folder. That's all a new override/texture file needs to follow to be
// picked up automatically - no code changes required.
//
// After patching, every touched live file is also copied into packed-mod/<dataDirName>/...
// (mirroring the game's own folder layout) so the repo always reflects what's actually
// live in the game. Pass a version as the first argument (e.g. "v0.3.3") to additionally
// zip packed-mod/<dataDirName>/ into packed-mod/<version>.zip, ready to upload.
//
// Usage: dotnet run --project tools/asset-importer [-- <version>]
// Requires tools/asset-importer/config.json (see config.example.json).

using System.Drawing;
using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;
using AssetImporter;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Cpp2IL;
using AssetsTools.NET.Texture;

var toolDir = AppContext.BaseDirectory;
var repoRoot = FindRepoRoot(toolDir);
var config = LoadConfig(repoRoot);
var dataDir = FindDataDir(config.GamePath);
var bundlesRoot = Path.Combine(dataDir, "StreamingAssets", "AssetBundles", "Windows");

var fontInputDir = Path.Combine(repoRoot, "font-assets", "input");
var fontMapping = LoadFontMapping(Path.Combine(toolDir, "font-mapping.json"));

// "<name>-<CAB-hash, file.assets, or bare level file like level2>-<pathId>.<json|txt|png>"
var pattern = new Regex(@"^(?<name>.+)-(?<container>CAB-[0-9a-fA-F]{32}|[^\\/]+\.assets|level\d+)-(?<pathid>-?\d+)\.(?<ext>json|txt|png)$");

// A container is "direct" (a data file sitting straight in dataDir) if it's an explicit
// "<file>.assets" name or a bare level file like "level2" - everything else is a bundle
// entry name (a "CAB-<hash>") that has to be located inside one of the bundle files.
static bool IsDirectContainer(string container) =>
    container.EndsWith(".assets", StringComparison.OrdinalIgnoreCase) || Regex.IsMatch(container, @"^level\d+$");

var jobs = new List<ImportJob>();
CollectJobs(Path.Combine(repoRoot, "text", "translated"), recursive: false, useFontMapping: false);
CollectJobs(Path.Combine(repoRoot, "font-assets", "output"), recursive: true, useFontMapping: true);
CollectJobs(Path.Combine(repoRoot, "asset-overrides"), recursive: false, useFontMapping: false);
CollectJobs(Path.Combine(repoRoot, "images", "translations", "Belarusian"), recursive: false, useFontMapping: false);

void CollectJobs(string dir, bool recursive, bool useFontMapping)
{
    if (!Directory.Exists(dir)) return;

    foreach (var path in Directory.GetFiles(dir, "*", recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly))
    {
        var match = pattern.Match(Path.GetFileName(path));
        if (!match.Success) continue;

        var name = match.Groups["name"].Value;
        var ext = match.Groups["ext"].Value;
        string? atlasPngPath = null;
        if (useFontMapping)
        {
            if (!fontMapping.TryGetValue(name, out var atlasPngName))
            {
                Console.WriteLine($"WARNING: no font-mapping.json entry for '{name}', skipping {Path.GetFileName(path)}");
                continue;
            }
            atlasPngPath = Path.Combine(fontInputDir, atlasPngName);
        }

        // a bare .png job (not paired with a font's JSON) is a direct texture replacement
        var isDirectTexture = ext == "png" && atlasPngPath == null;

        jobs.Add(new ImportJob(path, name, match.Groups["container"].Value,
            long.Parse(match.Groups["pathid"].Value), atlasPngPath, isDirectTexture));
    }
}

if (jobs.Count == 0)
{
    Console.WriteLine("No matching files found.");
    return 1;
}

Console.WriteLine($"Found {jobs.Count} file(s) to import:");
foreach (var job in jobs)
{
    var suffix = job.IsDirectTexture ? " (texture)" : job.AtlasPngPath != null ? " (+ atlas)" : "";
    Console.WriteLine($"  {job.DisplayName} -> {job.Container} @ {job.PathId}{suffix}");
}

// Cpp2IL is only needed for assets without an embedded type tree, and it's slow to set
// up (parses the game's whole IL2CPP binary) - build it at most once per run and share it.
Cpp2IlTempGenerator? sharedCpp2Il = null;
Cpp2IlTempGenerator GetCpp2Il()
{
    if (sharedCpp2Il == null)
    {
        var metaPath = Path.Combine(dataDir, "il2cpp_data", "Metadata", "global-metadata.dat");
        var asmPath = Path.Combine(config.GamePath, "GameAssembly.dll");
        if (!File.Exists(metaPath) || !File.Exists(asmPath))
        {
            throw new FileNotFoundException($"IL2CPP metadata not found ({metaPath} / {asmPath})");
        }
        Console.WriteLine("  (setting up IL2CPP metadata - this takes a moment)");
        sharedCpp2Il = new Cpp2IlTempGenerator(metaPath, asmPath);
    }
    return sharedCpp2Il;
}

// Ad-hoc diagnostic: `dotnet run -- scan-term <substring> <file1> [file2...]`
// Finds which MonoBehaviour(s) in the given direct data file(s) contain a string field
// matching <substring>, then dumps the owning GameObject's sibling components (RectTransform
// extents, TMP font-size/auto-size fields) so a UI layout/font-size bug can be traced to its
// actual asset. Not part of the shipping import pipeline.
if (args.Length > 0 && args[0] == "scan-term")
{
    return ScanForTerm(args[1], args.Skip(2).ToArray());
}

// Ad-hoc diagnostic: `dotnet run -- dump-font <bundleRelativePathUnderfonts/...> <fontName>`
// Dumps a TMP_FontAsset's m_FaceInfo (point size, scale, line metrics) from a bundle -
// used to compare a pristine "-original" backup's font metrics against a replacement's
// font-assets/output JSON, to check for a point-size mismatch that would make all text
// rendered in a swapped font come out a uniformly different size.
if (args.Length > 0 && args[0] == "dump-font")
{
    return DumpFontFaceInfo(Path.Combine(bundlesRoot, args[1]), args[2]);
}

// Ad-hoc diagnostic: `dotnet run -- patch-delete-button <pivotX> <sizeDeltaX>`
// Rapid-iteration test patch for the "DeleteGameButton/Text" RectTransform (level2,
// pathId 15409) - it currently has m_SizeDelta=(0,0) and m_Pivot=(0.5,0.5), i.e. an
// exact zero-width point anchor, which is the suspected trigger for TMP wrapping every
// character onto its own line regardless of the word-wrap setting. This writes straight
// to the live level2 file (via the usual -original backup) for quick in-game testing,
// bypassing the asset-overrides/ pipeline until a value is confirmed to work.
if (args.Length > 0 && args[0] == "patch-delete-button")
{
    return PatchDeleteButtonRect(float.Parse(args[1]), float.Parse(args[2]));
}

// Ad-hoc diagnostic: `dotnet run -- list-terms <file> [substring]`
// Lists every non-empty "mTerm" value found on any Localize MonoBehaviour in a direct
// data file, optionally filtered to those containing `substring` (case-insensitive) - a
// quick way to find a term's real key name when guessing exact substrings isn't working.
if (args.Length > 0 && args[0] == "list-terms")
{
    // last arg is treated as the filter substring only if it doesn't look like a filename
    // that exists in dataDir - simplest unambiguous rule: pass filter first, then files.
    return ListTerms(args[1], args.Skip(2).ToArray());
}

// Ad-hoc diagnostic: `dotnet run -- list-terms-bundle <bundleRelativePath> [substring]`
// Same as list-terms but for a bundle file (e.g. "shared/content.bundle") instead of a
// direct data file - scans every container inside it.
if (args.Length > 0 && args[0] == "list-terms-bundle")
{
    return ListTermsInBundle(Path.Combine(bundlesRoot, args[1]), args.Length > 2 ? args[2] : null);
}

// Ad-hoc diagnostic: `dotnet run -- find-lockit-value <bundleRelativePath> <substring>`
// Searches a Lockit-style MonoBehaviour's mSource.mTerms array (GeneralLockit/DialoguesLockit
// shape: each entry has a Term name plus a Languages array of translated strings) for any
// translation string containing `substring`, printing the owning asset name, term name, and
// language index - for recovering text that's live in the bundle but missing from the
// tracked JSON source (the class of bug documented for MAIN_MENU_C4_TAGLINE).
if (args.Length > 0 && args[0] == "find-lockit-value")
{
    return FindLockitValue(Path.Combine(bundlesRoot, args[1]), args[2]);
}

// Ad-hoc diagnostic: `dotnet run -- dump-tree <file> <rectTransformPathId> [maxDepth]`
// Prints a RectTransform's GameObject name + key components, then recurses into its
// m_Children, to inspect a whole UI panel's layout (siblings like dice icons next to a
// text label) rather than one object's own ancestor chain.
if (args.Length > 0 && args[0] == "dump-tree")
{
    return DumpTree(args[1], long.Parse(args[2]), args.Length > 3 ? int.Parse(args[3]) : 3);
}

// Ad-hoc diagnostic: `dotnet run -- dump-object <file> <gameObjectPathId>`
// Fully dumps every component (all fields) on one GameObject by its own pathId - for
// inspecting a specific object (e.g. a LayoutGroup) found via dump-tree.
if (args.Length > 0 && args[0] == "dump-object")
{
    return DumpObject(args[1], long.Parse(args[2]));
}

// Ad-hoc diagnostic: `dotnet run -- patch-field <file> <pathId>:<field.path>=<value> [more...]`
// Generic live-file version of the $fieldPatch override mechanism, for rapid in-game
// iteration on any direct data file before committing a value to asset-overrides/. All
// edits (even across multiple pathIds) are applied together in one rebuild from the
// pristine backup, so unrelated live-tested fixes on the same file aren't clobbered.
if (args.Length > 0 && args[0] == "patch-field")
{
    var edits = args.Skip(2).Select(a =>
    {
        var colon = a.IndexOf(':');
        var eq = a.IndexOf('=');
        return (PathId: long.Parse(a[..colon]), Field: a[(colon + 1)..eq], Value: a[(eq + 1)..]);
    }).ToList();
    return PatchFieldLive(args[1], edits);
}

// resolve each job's container to either a bundle file, or a direct "<file>.assets" in dataDir
var bundleFiles = Directory.Exists(bundlesRoot)
    ? Directory.GetFiles(bundlesRoot, "*", SearchOption.AllDirectories)
        .Where(f => !f.EndsWith(".manifest", StringComparison.OrdinalIgnoreCase)).ToList()
    : new List<string>();

var directContainers = new HashSet<string>(jobs.Select(j => j.Container).Where(IsDirectContainer));
var bundleContainers = new HashSet<string>(jobs.Select(j => j.Container).Where(c => !IsDirectContainer(c)));

Console.WriteLine("\nLocating containers...");

// fast path: exact CAB-hash match against each bundle's directory entries
var containerToBundle = new Dictionary<string, string>();
foreach (var container in bundleContainers)
{
    string? found = bundleFiles.FirstOrDefault(f => BundleContainsEntry(f, container));
    if (found != null)
    {
        containerToBundle[container] = found;
        Console.WriteLine($"  {container} -> {Path.GetRelativePath(bundlesRoot, found)} (bundle)");
    }
}

// Resolve every bundle-hosted job to its actual (bundleFile, container). Jobs whose
// container matched above inherit it directly. The rest have a container whose CAB hash
// no longer exists in any bundle at all - a full container-level drift (e.g. after a
// rebuild), not just a stale pathId within an otherwise-found container - so fall back to
// scanning every bundle for an asset matching this job's name instead of the stale hash.
var jobTarget = new Dictionary<ImportJob, (string BundleFile, string Container)>();
foreach (var job in jobs.Where(j => bundleContainers.Contains(j.Container)))
{
    if (containerToBundle.TryGetValue(job.Container, out var bundleFile))
    {
        jobTarget[job] = (bundleFile, job.Container);
        continue;
    }

    Console.WriteLine($"  {job.Container} not found directly, searching all bundles by name for '{job.DisplayName}'...");
    var expectedType = job.IsDirectTexture ? AssetClassID.Texture2D : AssetClassID.MonoBehaviour;
    var found = FindContainerByName(bundleFiles, toolDir, job, expectedType, GetCpp2Il);
    if (found == null)
    {
        Console.WriteLine($"ERROR: couldn't find '{job.DisplayName}' in any bundle under {bundlesRoot} (by container {job.Container} or by name)");
        return 1;
    }
    Console.WriteLine($"  WARNING: {job.Container} drifted - '{job.DisplayName}' found instead in {Path.GetRelativePath(bundlesRoot, found.Value.BundleFile)} / {found.Value.Container}");
    jobTarget[job] = (found.Value.BundleFile, found.Value.Container);
}

foreach (var container in directContainers)
{
    var directPath = Path.Combine(dataDir, container);
    if (!File.Exists(directPath))
    {
        Console.WriteLine($"ERROR: {container} not found directly in {dataDir}");
        return 1;
    }
    Console.WriteLine($"  {container} -> {container} (direct file)");
}

var touchedFiles = new List<string>();

// ============ bundle-hosted jobs ============
foreach (var group in jobTarget.Keys.GroupBy(j => jobTarget[j].BundleFile))
{
    var liveBundlePath = group.Key;
    var originalBackupPath = liveBundlePath + "-original";

    if (!File.Exists(originalBackupPath))
    {
        Console.WriteLine($"\nNo pristine backup found, creating one: {Path.GetFileName(originalBackupPath)}");
        File.Copy(liveBundlePath, originalBackupPath);
    }

    Console.WriteLine($"\nPatching {Path.GetRelativePath(config.GamePath, liveBundlePath)} (from pristine backup)...");

    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));

    var bunInst = manager.LoadBundleFile(originalBackupPath);
    var dirInfos = bunInst.file.BlockAndDirInfo.DirectoryInfos;

    foreach (var containerGroup in group.GroupBy(j => jobTarget[j].Container))
    {
        var container = containerGroup.Key;
        var idx = dirInfos.ToList().FindIndex(d => d.Name == container);
        if (idx < 0)
        {
            Console.WriteLine($"  ERROR: {container} disappeared from the pristine backup?");
            return 1;
        }

        var fileInst = manager.LoadAssetsFileFromBundle(bunInst, idx);
        manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
        if (!fileInst.file.Metadata.TypeTreeEnabled)
        {
            manager.MonoTempGenerator = GetCpp2Il();
        }

        foreach (var job in containerGroup)
        {
            if (!PatchAsset(manager, fileInst, job)) return 1;
        }

        dirInfos[idx].SetNewData(fileInst.file);
    }

    var bundleWriteOk = WriteReplacing(() => { using var s = File.Create(liveBundlePath + ".tmp"); bunInst.file.Write(new AssetsFileWriter(s)); }, liveBundlePath, config.GamePath);
    manager.UnloadAll(); // release the bundle's own file + any dependencies loadDeps pulled in
    if (!bundleWriteOk)
    {
        return 1;
    }
    touchedFiles.Add(liveBundlePath);
}

// ============ direct-file jobs (resources.assets, sharedassets1.assets, ...) ============
foreach (var container in directContainers)
{
    var livePath = Path.Combine(dataDir, container);
    var originalBackupPath = livePath + "-original";

    if (!File.Exists(originalBackupPath))
    {
        Console.WriteLine($"\nNo pristine backup found, creating one: {Path.GetFileName(originalBackupPath)}");
        File.Copy(livePath, originalBackupPath);
    }

    Console.WriteLine($"\nPatching {Path.GetRelativePath(config.GamePath, livePath)} (from pristine backup)...");

    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));

    // loadDeps:true so cross-file MonoScript references resolve; the backup sits next to
    // the live file so its sibling dependency files are found the same way.
    var fileInst = manager.LoadAssetsFile(originalBackupPath, true);
    manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
    if (!fileInst.file.Metadata.TypeTreeEnabled)
    {
        manager.MonoTempGenerator = GetCpp2Il();
    }

    foreach (var job in jobs.Where(j => j.Container == container))
    {
        if (!PatchAsset(manager, fileInst, job)) return 1;
    }

    var writeOk = WriteReplacing(() => { using var s = File.Create(livePath + ".tmp"); fileInst.file.Write(new AssetsFileWriter(s)); }, livePath, config.GamePath);
    manager.UnloadAll(); // release this file + any dependencies loadDeps pulled in (e.g. resources.assets)
    if (!writeOk)
    {
        return 1;
    }
    touchedFiles.Add(livePath);
}

// ============ mirror everything touched into packed-mod/ for shipping ============
Console.WriteLine($"\nCopying {touchedFiles.Count} touched file(s) into packed-mod/...");
var packedModDir = Path.Combine(repoRoot, "packed-mod");
foreach (var liveFile in touchedFiles)
{
    var relPath = Path.GetRelativePath(config.GamePath, liveFile);
    var destPath = Path.Combine(packedModDir, relPath);
    Directory.CreateDirectory(Path.GetDirectoryName(destPath)!);
    File.Copy(liveFile, destPath, overwrite: true);
    Console.WriteLine($"  {relPath}");
}

// ============ optionally zip packed-mod/<dataDirName>/ for release ============
if (args.Length > 0)
{
    var version = args[0];
    var dataDirName = Path.GetFileName(dataDir);
    var packedModDataDir = Path.Combine(packedModDir, dataDirName);
    var zipPath = Path.Combine(packedModDir, $"{version}.zip");

    if (!Directory.Exists(packedModDataDir))
    {
        Console.WriteLine($"\nERROR: {packedModDataDir} doesn't exist, nothing to zip.");
        return 1;
    }

    Console.WriteLine($"\nZipping {Path.GetRelativePath(repoRoot, packedModDataDir)} -> {Path.GetRelativePath(repoRoot, zipPath)}...");
    if (File.Exists(zipPath)) File.Delete(zipPath);

    using (var zipStream = File.Create(zipPath))
    using (var archive = new ZipArchive(zipStream, ZipArchiveMode.Create))
    {
        foreach (var file in Directory.GetFiles(packedModDataDir, "*", SearchOption.AllDirectories))
        {
            var entryName = Path.GetRelativePath(packedModDir, file).Replace('\\', '/');
            archive.CreateEntryFromFile(file, entryName, CompressionLevel.Optimal);
        }
    }
    Console.WriteLine($"  wrote {Path.GetRelativePath(repoRoot, zipPath)}");
}

Console.WriteLine("\nDone.");
return 0;

// Writes `writeTmp` (expected to create "<livePath>.tmp") then atomically swaps it in.
// A couple of retries with a short wait absorbs the common case of a brief AV-scan lock
// on the freshly-written file; it's not about the game holding the file open.
static bool WriteReplacing(Action writeTmp, string livePath, string gamePath)
{
    var tempOutPath = livePath + ".tmp";
    writeTmp();

    const int maxAttempts = 5;
    for (int attempt = 1; attempt <= maxAttempts; attempt++)
    {
        try
        {
            File.Move(tempOutPath, livePath, overwrite: true);
            Console.WriteLine($"  wrote {Path.GetRelativePath(gamePath, livePath)}");
            return true;
        }
        catch (IOException) when (attempt < maxAttempts)
        {
            Thread.Sleep(300 * attempt);
        }
        catch (UnauthorizedAccessException) when (attempt < maxAttempts)
        {
            Thread.Sleep(300 * attempt);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  ERROR: couldn't replace {livePath} ({ex.Message}).");
            Console.WriteLine("  Is the game currently running and holding this file open? Close it and retry.");
            File.Delete(tempOutPath);
            return false;
        }
    }

    return false;
}

// Imports a MonoBehaviour dump (JSON or UABE plain-text format, by extension), or a
// direct Texture2D replacement (a bare .png job, e.g. a translated UI button), into
// `job.PathId`. If the job carries an atlas PNG (fonts only), also overwrites that
// font's atlas Texture2D with the PNG's alpha channel (vertically flipped to match
// Unity's texture row order).
static bool PatchAsset(AssetsManager manager, AssetsFileInstance fileInst, ImportJob job)
{
    var info = fileInst.file.GetAssetInfo(job.PathId);
    var resolvedName = info != null ? TryGetName(manager, fileInst, info) : null;
    // When the pathId hits, scope the by-name fallback search to that same concrete type
    // (e.g. RectTransform, not just MonoBehaviour) instead of guessing - lets overrides
    // target built-in engine components (Transform/RectTransform/...) too, not just
    // MonoBehaviours and Texture2Ds.
    var expectedType = job.IsDirectTexture ? AssetClassID.Texture2D
        : info != null ? (AssetClassID)info.TypeId
        : AssetClassID.MonoBehaviour;

    // Fast path (pathId hit and its name matches) is the common case. Otherwise the
    // pathId either moved or got reassigned to a different asset entirely (both are real
    // risks across a game rebuild) - fall back to finding the asset by its own name
    // instead of trusting a potentially-stale/wrong pathId. Anonymous objects (Transforms,
    // most Components) have no m_Name at all, so an empty resolved name can't signal drift
    // one way or the other - trust the pathId hit for those rather than forcing a fallback
    // search that could never succeed (nothing to match by name).
    var driftSuspected = info == null || (!string.IsNullOrEmpty(resolvedName) && resolvedName != job.DisplayName);
    if (driftSuspected)
    {
        var oldPathId = job.PathId;
        var candidates = fileInst.file.GetAssetsOfType(expectedType)
            .Select(c => (Info: c, Name: TryGetName(manager, fileInst, c)))
            .Where(c => c.Name == job.DisplayName)
            .ToList();

        if (candidates.Count == 0)
        {
            var atPathId = info != null ? $"'{resolvedName}'" : "(pathId missing)";
            Console.WriteLine($"  ERROR: '{job.DisplayName}' not found in {job.Container} by pathId {oldPathId} (found {atPathId} there) or by name (checked {expectedType})");
            return false;
        }
        if (candidates.Count > 1)
        {
            Console.WriteLine($"  ERROR: '{job.DisplayName}' matched multiple assets in {job.Container} by name: {string.Join(", ", candidates.Select(c => c.Info.PathId))}");
            return false;
        }

        info = candidates[0].Info;
        Console.WriteLine($"  WARNING: {job.DisplayName} drifted (was pathId {oldPathId}, now {info.PathId}) - resolved by name");
    }

    // A field-patch override (top-level "$fieldPatch": { "dotted.field.path": value }) sets
    // just those fields on the object as it exists live, rather than replacing the whole
    // object from a full dump - the only practical option for anonymous engine components
    // like a RectTransform, and a much smaller diff for a one-field tweak (e.g. font size)
    // on an otherwise-untouched MonoBehaviour.
    if (job.JsonPath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(job.JsonPath));
        if (doc.RootElement.TryGetProperty("$fieldPatch", out var patch))
        {
            var patchField = manager.GetBaseField(fileInst, info);
            if (!ApplyFieldPatch(patchField, patch, job.DisplayName)) return false;
            info.SetNewData(patchField);
            Console.WriteLine($"  patched {job.DisplayName}");
            return true;
        }
    }

    if (job.IsDirectTexture)
    {
        var texBaseField = manager.GetBaseField(fileInst, info);
        var tex = TextureFile.ReadTextureFile(texBaseField);
        var originalFormat = (TextureFormat)tex.m_TextureFormat;
        // Crunched formats can only be decoded, never re-encoded - fall back to plain
        // RGBA32 for those; every other format (compressed or not) keeps its own format.
        var isCrunched = originalFormat is TextureFormat.DXT1Crunched or TextureFormat.DXT5Crunched
            or TextureFormat.ETC_RGB4Crunched or TextureFormat.ETC2_RGBA8Crunched;
        var targetFormat = isCrunched ? TextureFormat.RGBA32 : originalFormat;

        // The vendored encoder's own internal flip nets out to storing pixels top-down
        // (matching a normal PNG), but Unity renders this game's textures assuming
        // bottom-up storage - confirmed in-game (buttons rendered vertically flipped,
        // same left-right layout/position otherwise). Pre-flip the source vertically so
        // the net result after encoding is the bottom-up order Unity actually wants.
        var flippedPath = FlipImageVertically(job.JsonPath);
        try
        {
            tex.EncodeTextureImage(flippedPath, targetFormat, 1);
        }
        finally
        {
            File.Delete(flippedPath);
        }
        tex.WriteTo(texBaseField);
        info.SetNewData(texBaseField);
        Console.WriteLine($"  imported {job.DisplayName} ({tex.m_Width}x{tex.m_Height}, {targetFormat}{(isCrunched ? $", was {originalFormat}" : "")})");
        return true;
    }

    var baseField = manager.GetBaseField(fileInst, info);
    long atlasPathId = job.AtlasPngPath != null ? baseField["m_AtlasTextures"]["Array"][0]["m_PathID"].AsLong : 0;

    using (var fs = File.OpenRead(job.JsonPath))
    {
        var importer = new AssetImport(fs, manager.GetRefTypeManager(fileInst));
        var isText = job.JsonPath.EndsWith(".txt", StringComparison.OrdinalIgnoreCase);

        byte[]? data;
        string? err;
        if (isText)
        {
            data = importer.ImportTextAsset(out err);
        }
        else
        {
            var tempField = manager.GetTemplateBaseField(fileInst, info);
            data = importer.ImportJsonAsset(tempField, out err);
        }

        if (data == null)
        {
            Console.WriteLine($"  IMPORT FAILED for {job.DisplayName}: {err}");
            return false;
        }

        info.SetNewData(data);
    }
    Console.WriteLine($"  imported {job.DisplayName}");

    if (job.AtlasPngPath != null)
    {
        var atlasInfo = fileInst.file.GetAssetInfo(atlasPathId);
        var atlasField = manager.GetBaseField(fileInst, atlasInfo);
        var pixels = LoadAlphaChannelFlippedVertically(job.AtlasPngPath, out var w, out var h);

        atlasField["m_Width"].AsInt = w;
        atlasField["m_Height"].AsInt = h;
        atlasField["m_CompleteImageSize"].AsInt = pixels.Length;
        atlasField["m_TextureFormat"].AsInt = 1; // Alpha8 - matches our raw single-channel pixel data
        atlasField["image data"].AsByteArray = pixels;
        atlasField["m_StreamData"]["offset"].AsULong = 0;
        atlasField["m_StreamData"]["size"].AsUInt = 0;
        atlasField["m_StreamData"]["path"].AsString = "";
        atlasInfo.SetNewData(atlasField);
        Console.WriteLine($"    + atlas from {Path.GetFileName(job.AtlasPngPath)} ({w}x{h})");
    }

    return true;
}

// Sets each "dotted.field.path": value pair in `patch` on `baseField` in place. The
// target field's own AssetValueType decides which typed setter to use, so JSON numbers
// (which don't distinguish int/float) land correctly either way.
static bool ApplyFieldPatch(AssetTypeValueField baseField, JsonElement patch, string displayName)
{
    foreach (var prop in patch.EnumerateObject())
    {
        var field = baseField;
        foreach (var segment in prop.Name.Split('.')) field = field[segment];

        if (field.Value == null)
        {
            Console.WriteLine($"  ERROR: field patch path '{prop.Name}' on {displayName} doesn't resolve to a value field");
            return false;
        }

        switch (field.Value.ValueType)
        {
            case AssetValueType.Bool: field.AsBool = prop.Value.GetBoolean(); break;
            case AssetValueType.Int8: field.AsSByte = (sbyte)prop.Value.GetInt32(); break;
            case AssetValueType.UInt8: field.AsByte = (byte)prop.Value.GetInt32(); break;
            case AssetValueType.Int16: field.AsShort = (short)prop.Value.GetInt32(); break;
            case AssetValueType.UInt16: field.AsUShort = (ushort)prop.Value.GetInt32(); break;
            case AssetValueType.Int32: field.AsInt = prop.Value.GetInt32(); break;
            case AssetValueType.UInt32: field.AsUInt = (uint)prop.Value.GetInt64(); break;
            case AssetValueType.Int64: field.AsLong = prop.Value.GetInt64(); break;
            case AssetValueType.UInt64: field.AsULong = (ulong)prop.Value.GetInt64(); break;
            case AssetValueType.Float: field.AsFloat = (float)prop.Value.GetDouble(); break;
            case AssetValueType.Double: field.AsDouble = prop.Value.GetDouble(); break;
            case AssetValueType.String: field.AsString = prop.Value.GetString() ?? ""; break;
            default:
                Console.WriteLine($"  ERROR: field patch path '{prop.Name}' on {displayName} has unsupported type {field.Value.ValueType}");
                return false;
        }

        Console.WriteLine($"    {prop.Name} = {prop.Value}");
    }
    return true;
}

// TextMeshPro SDF atlases are Alpha8 (1 byte/pixel); Unity's texture row 0 is the
// bottom row, opposite of a PNG's top-down row order, so rows are flipped here.
static byte[] LoadAlphaChannelFlippedVertically(string pngPath, out int width, out int height)
{
    using var bmp = new Bitmap(pngPath);
    width = bmp.Width;
    height = bmp.Height;
    var bytes = new byte[width * height];
    for (int y = 0; y < height; y++)
    {
        int srcY = height - 1 - y;
        for (int x = 0; x < width; x++)
        {
            bytes[y * width + x] = bmp.GetPixel(x, srcY).A;
        }
    }
    return bytes;
}

// Writes a vertically-flipped copy of `pngPath` to a temp file and returns its path
// (caller deletes it). Used for direct texture imports - see the comment at the call site.
static string FlipImageVertically(string pngPath)
{
    using var bmp = new Bitmap(pngPath);
    bmp.RotateFlip(System.Drawing.RotateFlipType.RotateNoneFlipY);
    var tempPath = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".png");
    bmp.Save(tempPath, System.Drawing.Imaging.ImageFormat.Png);
    return tempPath;
}

static bool BundleContainsEntry(string bundleFile, string container)
{
    try
    {
        using var stream = File.OpenRead(bundleFile);
        var reader = new AssetsFileReader(stream);
        var bundle = new AssetBundleFile();
        bundle.Read(reader);
        return bundle.BlockAndDirInfo.DirectoryInfos.Any(d => d.Name == container);
    }
    catch
    {
        return false;
    }
}

// Reads an asset's own m_Name field - the identity we trust over a filename-embedded
// pathId/container, since it's what UABE's export convention names files after.
static string? TryGetName(AssetsManager manager, AssetsFileInstance fileInst, AssetFileInfo info)
{
    try
    {
        return manager.GetBaseField(fileInst, info)["m_Name"].AsString;
    }
    catch
    {
        return null;
    }
}

// Fallback for full container-level drift: a job's CAB hash doesn't exist in any bundle
// anymore (e.g. after a rebuild reshuffled bundle contents). Scans every bundle's every
// container for an asset of the expected type whose m_Name matches the job's name.
static (string BundleFile, string Container)? FindContainerByName(
    List<string> bundleFiles, string toolDir, ImportJob job, AssetClassID expectedType, Func<Cpp2IlTempGenerator> getCpp2Il)
{
    foreach (var bundleFile in bundleFiles)
    {
        var manager = new AssetsManager();
        manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));

        BundleFileInstance? bunInst = null;
        try
        {
            bunInst = manager.LoadBundleFile(bundleFile);
        }
        catch
        {
            // not a readable bundle - skip it
        }

        if (bunInst == null)
        {
            manager.UnloadAll();
            continue;
        }

        var dirInfos = bunInst.file.BlockAndDirInfo.DirectoryInfos;
        for (var idx = 0; idx < dirInfos.Count; idx++)
        {
            AssetsFileInstance? fileInst = null;
            try
            {
                fileInst = manager.LoadAssetsFileFromBundle(bunInst, idx);
                manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
                if (!fileInst.file.Metadata.TypeTreeEnabled)
                {
                    manager.MonoTempGenerator = getCpp2Il();
                }
            }
            catch
            {
                fileInst = null;
            }

            if (fileInst == null) continue;

            var match = fileInst.file.GetAssetsOfType(expectedType)
                .FirstOrDefault(c => TryGetName(manager, fileInst, c) == job.DisplayName);
            if (match != null)
            {
                var container = dirInfos[idx].Name;
                manager.UnloadAll();
                return (bundleFile, container);
            }
        }

        manager.UnloadAll();
    }

    return null;
}

int PatchFieldLive(string fileName, List<(long PathId, string Field, string Value)> edits)
{
    var livePath = Path.Combine(dataDir, fileName);
    var originalBackupPath = livePath + "-original";
    if (!File.Exists(originalBackupPath))
    {
        Console.WriteLine($"Creating pristine backup: {Path.GetFileName(originalBackupPath)}");
        File.Copy(livePath, originalBackupPath);
    }

    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var fileInst = manager.LoadAssetsFile(originalBackupPath, true);
    manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
    if (!fileInst.file.Metadata.TypeTreeEnabled)
    {
        manager.MonoTempGenerator = GetCpp2Il();
    }

    foreach (var group in edits.GroupBy(e => e.PathId))
    {
        var info = fileInst.file.GetAssetInfo(group.Key);
        if (info == null) { Console.WriteLine($"ERROR: pathId {group.Key} not found in {fileName}"); return 1; }
        var baseField = manager.GetBaseField(fileInst, info);

        foreach (var (_, fieldPath, value) in group)
        {
            var field = baseField;
            foreach (var segment in fieldPath.Split('.')) field = field[segment];
            if (field.Value == null) { Console.WriteLine($"ERROR: '{fieldPath}' doesn't resolve to a value field"); return 1; }

            switch (field.Value.ValueType)
            {
                case AssetValueType.Bool: field.AsBool = bool.Parse(value); break;
                case AssetValueType.Int8: field.AsSByte = sbyte.Parse(value); break;
                case AssetValueType.UInt8: field.AsByte = byte.Parse(value); break;
                case AssetValueType.Int16: field.AsShort = short.Parse(value); break;
                case AssetValueType.UInt16: field.AsUShort = ushort.Parse(value); break;
                case AssetValueType.Int32: field.AsInt = int.Parse(value); break;
                case AssetValueType.UInt32: field.AsUInt = uint.Parse(value); break;
                case AssetValueType.Int64: field.AsLong = long.Parse(value); break;
                case AssetValueType.UInt64: field.AsULong = ulong.Parse(value); break;
                case AssetValueType.Float: field.AsFloat = float.Parse(value); break;
                case AssetValueType.Double: field.AsDouble = double.Parse(value); break;
                case AssetValueType.String: field.AsString = value; break;
                default: Console.WriteLine($"ERROR: '{fieldPath}' has unsupported type {field.Value.ValueType}"); return 1;
            }
            Console.WriteLine($"  pathId {group.Key}: {fieldPath} = {value}");
        }

        info.SetNewData(baseField);
    }

    var ok = WriteReplacing(() => { using var s = File.Create(livePath + ".tmp"); fileInst.file.Write(new AssetsFileWriter(s)); }, livePath, config.GamePath);
    manager.UnloadAll();
    return ok ? 0 : 1;
}

int DumpObject(string fileName, long gameObjectPathId)
{
    var path = Path.Combine(dataDir, fileName);
    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var fileInst = manager.LoadAssetsFile(path, true);
    manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
    if (!fileInst.file.Metadata.TypeTreeEnabled)
    {
        manager.MonoTempGenerator = GetCpp2Il();
    }

    var info = fileInst.file.GetAssetInfo(gameObjectPathId);
    if (info == null) { Console.WriteLine($"ERROR: pathId {gameObjectPathId} not found in {fileName}"); return 1; }
    var goField = manager.GetBaseField(fileInst, info);
    var isActive = goField.Children.FirstOrDefault(f => f.FieldName == "m_IsActive")?.AsBool;
    Console.WriteLine($"GameObject '{goField["m_Name"].AsString}' (pathId {gameObjectPathId}) m_IsActive={isActive}:");
    DumpComponents(manager, fileInst, goField);
    manager.UnloadAll();
    return 0;
}

int DumpTree(string fileName, long rectTransformPathId, int maxDepth)
{
    var path = Path.Combine(dataDir, fileName);
    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var fileInst = manager.LoadAssetsFile(path, true);
    manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
    if (!fileInst.file.Metadata.TypeTreeEnabled)
    {
        manager.MonoTempGenerator = GetCpp2Il();
    }

    var info = fileInst.file.GetAssetInfo(rectTransformPathId);
    if (info == null) { Console.WriteLine($"ERROR: pathId {rectTransformPathId} not found in {fileName}"); return 1; }
    var rect = manager.GetBaseField(fileInst, info);
    DumpTreeNode(manager, fileInst, rect, 0, maxDepth);
    manager.UnloadAll();
    return 0;
}

static void DumpTreeNode(AssetsManager manager, AssetsFileInstance fileInst, AssetTypeValueField rect, int depth, int maxDepth)
{
    var indent = new string(' ', depth * 2);
    var goExt = manager.GetExtAsset(fileInst, rect["m_GameObject"]);
    var name = goExt.baseField?["m_Name"].AsString ?? "?";
    var sd = rect["m_SizeDelta"];
    Console.WriteLine($"{indent}'{name}' (GO pathId {goExt.info?.PathId}) sizeDelta=({sd["x"].AsFloat},{sd["y"].AsFloat})  components: {string.Join(", ", ListComponentTypeNames(manager, fileInst, goExt.baseField!))}");

    if (depth >= maxDepth) return;
    var children = rect["m_Children"]["Array"];
    foreach (var child in children.Children)
    {
        AssetTypeValueField childRect;
        try { childRect = manager.GetExtAsset(fileInst, child).baseField; } catch { continue; }
        if (childRect == null) continue;
        DumpTreeNode(manager, fileInst, childRect, depth + 1, maxDepth);
    }
}

int FindLockitValue(string bundlePath, string substring)
{
    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var bunInst = manager.LoadBundleFile(bundlePath);
    var dirInfos = bunInst.file.BlockAndDirInfo.DirectoryInfos;

    for (var idx = 0; idx < dirInfos.Count; idx++)
    {
        AssetsFileInstance fileInst;
        try
        {
            fileInst = manager.LoadAssetsFileFromBundle(bunInst, idx);
            manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
            if (!fileInst.file.Metadata.TypeTreeEnabled)
            {
                manager.MonoTempGenerator = GetCpp2Il();
            }
        }
        catch { continue; }

        foreach (var info in fileInst.file.GetAssetsOfType(AssetClassID.MonoBehaviour))
        {
            AssetTypeValueField baseField;
            try { baseField = manager.GetBaseField(fileInst, info); } catch { continue; }

            var mSource = baseField.Children.FirstOrDefault(f => f.FieldName == "mSource");
            var mTerms = mSource?["mTerms"]["Array"];
            if (mTerms == null || mTerms.Children.Count == 0) continue;

            var assetName = TryGetName(manager, fileInst, info);
            foreach (var term in mTerms.Children)
            {
                var languages = term["Languages"]["Array"];
                for (var li = 0; li < languages.Children.Count; li++)
                {
                    var val = languages.Children[li].AsString;
                    if (val != null && val.IndexOf(substring, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        Console.WriteLine($"[{dirInfos[idx].Name}] {assetName} (pathId {info.PathId}): Term='{term["Term"].AsString}' Languages[{li}]='{val}'");
                    }
                }
            }
        }
    }

    manager.UnloadAll();
    return 0;
}

int ListTermsInBundle(string bundlePath, string? filter)
{
    if (!File.Exists(bundlePath)) { Console.WriteLine($"ERROR: {bundlePath} not found"); return 1; }

    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var bunInst = manager.LoadBundleFile(bundlePath);
    var dirInfos = bunInst.file.BlockAndDirInfo.DirectoryInfos;

    var seen = new HashSet<string>();
    for (var idx = 0; idx < dirInfos.Count; idx++)
    {
        AssetsFileInstance fileInst;
        try
        {
            fileInst = manager.LoadAssetsFileFromBundle(bunInst, idx);
            manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
            if (!fileInst.file.Metadata.TypeTreeEnabled)
            {
                manager.MonoTempGenerator = GetCpp2Il();
            }
        }
        catch { continue; }

        foreach (var info in fileInst.file.GetAssetsOfType(AssetClassID.MonoBehaviour))
        {
            AssetTypeValueField baseField;
            try { baseField = manager.GetBaseField(fileInst, info); } catch { continue; }

            var termField = baseField.Children.FirstOrDefault(f => f.FieldName == "mTerm");
            if (termField == null) continue;
            var term = termField.AsString;
            if (string.IsNullOrEmpty(term)) continue;
            if (!string.IsNullOrEmpty(filter) && term.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (seen.Add(term))
            {
                Console.WriteLine($"[{dirInfos[idx].Name}] {term}  (pathId {info.PathId})");
            }
        }
    }

    manager.UnloadAll();
    return 0;
}

int ListTerms(string filter, string[] fileNames)
{
    foreach (var fileName in fileNames)
    {
        var path = Path.Combine(dataDir, fileName);
        if (!File.Exists(path)) { Console.WriteLine($"SKIP {fileName}: not found"); continue; }

        var manager = new AssetsManager();
        manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
        var fileInst = manager.LoadAssetsFile(path, true);
        manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
        if (!fileInst.file.Metadata.TypeTreeEnabled)
        {
            manager.MonoTempGenerator = GetCpp2Il();
        }

        var seen = new HashSet<string>();
        foreach (var info in fileInst.file.GetAssetsOfType(AssetClassID.MonoBehaviour))
        {
            AssetTypeValueField baseField;
            try { baseField = manager.GetBaseField(fileInst, info); } catch { continue; }

            var termField = baseField.Children.FirstOrDefault(f => f.FieldName == "mTerm");
            if (termField == null) continue;
            var term = termField.AsString;
            if (string.IsNullOrEmpty(term)) continue;
            if (!string.IsNullOrEmpty(filter) && term.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (seen.Add(term))
            {
                Console.WriteLine($"[{fileName}] {term}  (pathId {info.PathId})");
            }
        }

        manager.UnloadAll();
    }
    return 0;
}

int PatchDeleteButtonRect(float pivotX, float sizeDeltaX)
{
    var livePath = Path.Combine(dataDir, "level2");
    var originalBackupPath = livePath + "-original";
    if (!File.Exists(originalBackupPath))
    {
        Console.WriteLine($"Creating pristine backup: {Path.GetFileName(originalBackupPath)}");
        File.Copy(livePath, originalBackupPath);
    }

    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var fileInst = manager.LoadAssetsFile(originalBackupPath, true);
    manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
    if (!fileInst.file.Metadata.TypeTreeEnabled)
    {
        manager.MonoTempGenerator = GetCpp2Il();
    }

    var info = fileInst.file.GetAssetInfo(15409);
    var baseField = manager.GetBaseField(fileInst, info);
    Console.WriteLine($"Before: pivot=({baseField["m_Pivot"]["x"].AsFloat},{baseField["m_Pivot"]["y"].AsFloat}) sizeDelta=({baseField["m_SizeDelta"]["x"].AsFloat},{baseField["m_SizeDelta"]["y"].AsFloat})");

    baseField["m_Pivot"]["x"].AsFloat = pivotX;
    baseField["m_SizeDelta"]["x"].AsFloat = sizeDeltaX;
    info.SetNewData(baseField);

    Console.WriteLine($"After:  pivot=({baseField["m_Pivot"]["x"].AsFloat},{baseField["m_Pivot"]["y"].AsFloat}) sizeDelta=({baseField["m_SizeDelta"]["x"].AsFloat},{baseField["m_SizeDelta"]["y"].AsFloat})");

    var ok = WriteReplacing(() => { using var s = File.Create(livePath + ".tmp"); fileInst.file.Write(new AssetsFileWriter(s)); }, livePath, config.GamePath);
    manager.UnloadAll();
    return ok ? 0 : 1;
}

int DumpFontFaceInfo(string bundlePath, string fontName)
{
    if (!File.Exists(bundlePath))
    {
        Console.WriteLine($"ERROR: {bundlePath} not found");
        return 1;
    }

    var manager = new AssetsManager();
    manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));
    var bunInst = manager.LoadBundleFile(bundlePath);
    var dirInfos = bunInst.file.BlockAndDirInfo.DirectoryInfos;

    for (var idx = 0; idx < dirInfos.Count; idx++)
    {
        var fileInst = manager.LoadAssetsFileFromBundle(bunInst, idx);
        manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
        if (!fileInst.file.Metadata.TypeTreeEnabled)
        {
            manager.MonoTempGenerator = GetCpp2Il();
        }

        var match = fileInst.file.GetAssetsOfType(AssetClassID.MonoBehaviour)
            .FirstOrDefault(c => TryGetName(manager, fileInst, c) == fontName);
        if (match == null) continue;

        Console.WriteLine($"Found '{fontName}' in container {dirInfos[idx].Name}, pathId {match.PathId}");
        var baseField = manager.GetBaseField(fileInst, match);
        DumpField(baseField["m_FaceInfo"], 0, 2);
        manager.UnloadAll();
        return 0;
    }

    Console.WriteLine($"ERROR: '{fontName}' not found in any container of {bundlePath}");
    manager.UnloadAll();
    return 1;
}

int ScanForTerm(string term, string[] fileNames)
{
    foreach (var fileName in fileNames)
    {
        var path = Path.Combine(dataDir, fileName);
        if (!File.Exists(path))
        {
            Console.WriteLine($"SKIP {fileName}: not found under {dataDir}");
            continue;
        }

        Console.WriteLine($"\n=== Scanning {fileName} ===");
        var manager = new AssetsManager();
        manager.LoadClassPackage(Path.Combine(toolDir, "classdata.tpk"));

        var fileInst = manager.LoadAssetsFile(path, true);
        manager.LoadClassDatabaseFromPackage(fileInst.file.Metadata.UnityVersion);
        if (!fileInst.file.Metadata.TypeTreeEnabled)
        {
            manager.MonoTempGenerator = GetCpp2Il();
        }

        var hits = 0;
        foreach (var info in fileInst.file.GetAssetsOfType(AssetClassID.MonoBehaviour))
        {
            AssetTypeValueField baseField;
            try
            {
                baseField = manager.GetBaseField(fileInst, info);
            }
            catch
            {
                continue;
            }

            if (!FieldContainsString(baseField, term)) continue;
            hits++;

            Console.WriteLine($"\n--- MonoBehaviour hit: pathId {info.PathId} ---");
            DumpField(baseField, 0, 3);

            var goField = baseField.Children.FirstOrDefault(f => f.FieldName == "m_GameObject");
            if (goField == null)
            {
                Console.WriteLine("  (no m_GameObject field on this component)");
                continue;
            }

            var goExt = manager.GetExtAsset(fileInst, goField);
            if (goExt.baseField == null)
            {
                Console.WriteLine("  (couldn't resolve m_GameObject)");
                continue;
            }

            Console.WriteLine($"  GameObject '{goExt.baseField["m_Name"].AsString}' (pathId {goExt.info.PathId} in {(goExt.file == fileInst ? fileName : goExt.file.name)}):");
            DumpComponents(manager, goExt.file, goExt.baseField);

            Console.WriteLine("\n  --- walking up the Transform parent chain ---");
            WalkParents(manager, goExt.file, goExt.baseField);
        }

        Console.WriteLine($"\n{hits} MonoBehaviour(s) in {fileName} matched '{term}'.");
        manager.UnloadAll();
    }

    return 0;
}

// Recursively checks every leaf field for a string value containing `term`.
static bool FieldContainsString(AssetTypeValueField field, string term)
{
    if (field.Value != null && field.Value.ValueType == AssetValueType.String)
    {
        var s = field.Value.AsString;
        if (s != null && s.Contains(term, StringComparison.Ordinal)) return true;
    }

    foreach (var child in field.Children)
    {
        if (FieldContainsString(child, term)) return true;
    }

    return false;
}

static void DumpField(AssetTypeValueField field, int depth, int maxDepth)
{
    if (depth > maxDepth) return;
    var indent = new string(' ', depth * 2);
    var valueStr = field.Value != null && field.Value.ValueType != AssetValueType.None
        ? " = " + Truncate(field.Value.AsString ?? field.Value.ToString() ?? "", 120)
        : "";
    Console.WriteLine($"{indent}{field.FieldName} ({field.TypeName}){valueStr}");
    foreach (var child in field.Children)
    {
        DumpField(child, depth + 1, maxDepth);
    }
}

static string Truncate(string s, int max) => s.Length <= max ? s : s[..max] + "...";

// Unity built-in class IDs relevant to a UI GameObject's component list.
const int ClassId_GameObject = 1;
const int ClassId_Transform = 4;
const int ClassId_RectTransform = 224;
const int ClassId_MonoBehaviour = 114;

static void DumpComponents(AssetsManager manager, AssetsFileInstance goFile, AssetTypeValueField goField)
{
    var componentArray = goField["m_Component"]["Array"];
    foreach (var entry in componentArray.Children)
    {
        // Shapes seen across Unity versions: PPtr<Component> directly, { first, second: PPtr },
        // or { data: { component: PPtr } }.
        var pptrField = entry.Children.FirstOrDefault(c => c.FieldName == "second")
            ?? entry.Children.FirstOrDefault(c => c.FieldName == "component")
            ?? entry;
        if (pptrField.Children.FirstOrDefault(c => c.FieldName == "m_PathID") == null)
        {
            Console.WriteLine("    [unrecognized component entry shape]");
            DumpField(entry, 3, 4);
            continue;
        }
        var ext = manager.GetExtAsset(goFile, pptrField, true); // info only, avoid deep-parsing everything

        var typeId = ext.info?.TypeId ?? -1;
        if (typeId == ClassId_RectTransform || typeId == ClassId_Transform)
        {
            var full = manager.GetExtAsset(goFile, pptrField);
            var kind = typeId == ClassId_RectTransform ? "RectTransform" : "Transform";
            Console.WriteLine($"    [{kind}] pathId {full.info.PathId}");
            if (typeId == ClassId_RectTransform)
            {
                Console.WriteLine($"      m_SizeDelta = ({full.baseField["m_SizeDelta"]["x"].AsFloat}, {full.baseField["m_SizeDelta"]["y"].AsFloat})");
                Console.WriteLine($"      m_AnchorMin = ({full.baseField["m_AnchorMin"]["x"].AsFloat}, {full.baseField["m_AnchorMin"]["y"].AsFloat})");
                Console.WriteLine($"      m_AnchorMax = ({full.baseField["m_AnchorMax"]["x"].AsFloat}, {full.baseField["m_AnchorMax"]["y"].AsFloat})");
                Console.WriteLine($"      m_Pivot = ({full.baseField["m_Pivot"]["x"].AsFloat}, {full.baseField["m_Pivot"]["y"].AsFloat})");
                Console.WriteLine($"      m_AnchoredPosition = ({full.baseField["m_AnchoredPosition"]["x"].AsFloat}, {full.baseField["m_AnchoredPosition"]["y"].AsFloat})");
                var rot = full.baseField["m_LocalRotation"];
                Console.WriteLine($"      m_LocalRotation = ({rot["x"].AsFloat}, {rot["y"].AsFloat}, {rot["z"].AsFloat}, {rot["w"].AsFloat})");
                var scale = full.baseField["m_LocalScale"];
                Console.WriteLine($"      m_LocalScale = ({scale["x"].AsFloat}, {scale["y"].AsFloat}, {scale["z"].AsFloat})");
                var father = full.baseField["m_Father"];
                Console.WriteLine($"      m_Father = fileID {father["m_FileID"].AsInt}, pathID {father["m_PathID"].AsLong}");
            }
        }
        else if (typeId == ClassId_MonoBehaviour)
        {
            var full = manager.GetExtAsset(goFile, pptrField);
            var scriptField = full.baseField.Children.FirstOrDefault(f => f.FieldName == "m_Script");
            var scriptName = "?";
            if (scriptField != null)
            {
                try
                {
                    var scriptExt = manager.GetExtAsset(full.file, scriptField);
                    scriptName = scriptExt.baseField?["m_ClassName"]?.AsString ?? "?";
                }
                catch { /* best effort */ }
            }
            Console.WriteLine($"    [MonoBehaviour: {scriptName}] pathId {full.info.PathId}");
            foreach (var f in full.baseField.Children)
            {
                DumpField(f, 3, 4);
            }
        }
        else
        {
            Console.WriteLine($"    [ClassId {typeId}] pathId {ext.info?.PathId}");
        }
    }
}

// Finds the GameObject's own RectTransform/Transform component, then follows m_Father
// upward printing each ancestor's name + rotation/scale/rect, to catch a rotated or
// resized ancestor panel that would explain a UI element rendering wrong even though
// the element's own RectTransform looks fine.
static void WalkParents(AssetsManager manager, AssetsFileInstance goFile, AssetTypeValueField goField)
{
    var current = goField;
    var currentFile = goFile;
    for (int depth = 0; depth < 12 && current != null; depth++)
    {
        var xform = FindTransformComponent(manager, currentFile, current, out var xformFile);
        if (xform == null)
        {
            Console.WriteLine("  (no Transform/RectTransform component found)");
            return;
        }

        var name = current["m_Name"].AsString;
        var rot = xform["m_LocalRotation"];
        var scale = xform["m_LocalScale"];
        Console.WriteLine($"  '{name}': rotation=({rot["x"].AsFloat:F3},{rot["y"].AsFloat:F3},{rot["z"].AsFloat:F3},{rot["w"].AsFloat:F3}) scale=({scale["x"].AsFloat:F2},{scale["y"].AsFloat:F2},{scale["z"].AsFloat:F2})");
        Console.WriteLine($"    components: {string.Join(", ", ListComponentTypeNames(manager, currentFile, current))}");
        var sizeDeltaField = xform.Children.FirstOrDefault(f => f.FieldName == "m_SizeDelta");
        if (sizeDeltaField != null)
        {
            var min = xform["m_AnchorMin"]; var max = xform["m_AnchorMax"];
            Console.WriteLine($"    sizeDelta=({sizeDeltaField["x"].AsFloat},{sizeDeltaField["y"].AsFloat}) anchorMin=({min["x"].AsFloat},{min["y"].AsFloat}) anchorMax=({max["x"].AsFloat},{max["y"].AsFloat})");
        }

        var father = xform["m_Father"];
        var fatherPathId = father["m_PathID"].AsLong;
        if (fatherPathId == 0)
        {
            Console.WriteLine("  (reached root - no more parents)");
            return;
        }

        var fatherExt = manager.GetExtAsset(xformFile, father);
        if (fatherExt.baseField == null)
        {
            Console.WriteLine("  (couldn't resolve parent Transform)");
            return;
        }

        var goOfFather = fatherExt.baseField["m_GameObject"];
        var goExt = manager.GetExtAsset(fatherExt.file, goOfFather);
        if (goExt.baseField == null)
        {
            Console.WriteLine("  (couldn't resolve parent GameObject)");
            return;
        }

        current = goExt.baseField;
        currentFile = goExt.file;
    }
}

// Lists just the type name of every component on a GameObject (script name for
// MonoBehaviours, built-in class ID otherwise) - a quick way to spot a LayoutGroup/
// ContentSizeFitter without fully dumping every component's fields.
static List<string> ListComponentTypeNames(AssetsManager manager, AssetsFileInstance goFile, AssetTypeValueField goField)
{
    var names = new List<string>();
    var componentArray = goField["m_Component"]["Array"];
    foreach (var entry in componentArray.Children)
    {
        var pptrField = entry.Children.FirstOrDefault(c => c.FieldName == "second")
            ?? entry.Children.FirstOrDefault(c => c.FieldName == "component")
            ?? entry;
        if (pptrField.Children.FirstOrDefault(c => c.FieldName == "m_PathID") == null) continue;

        var infoExt = manager.GetExtAsset(goFile, pptrField, true);
        if (infoExt.info == null) { names.Add("?"); continue; }

        if (infoExt.info.TypeId == ClassId_MonoBehaviour)
        {
            var full = manager.GetExtAsset(goFile, pptrField);
            var scriptField = full.baseField.Children.FirstOrDefault(f => f.FieldName == "m_Script");
            var scriptName = "MonoBehaviour(?)";
            if (scriptField != null)
            {
                try
                {
                    var scriptExt = manager.GetExtAsset(full.file, scriptField);
                    scriptName = scriptExt.baseField?["m_ClassName"]?.AsString ?? scriptName;
                }
                catch { /* best effort */ }
            }
            names.Add($"{scriptName}#{full.info.PathId}");
        }
        else
        {
            names.Add($"ClassId{infoExt.info.TypeId}#{infoExt.info.PathId}");
        }
    }
    return names;
}

// Returns the RectTransform or Transform component attached to `goField`, and the file it
// lives in (may differ from `goFile` if the component is a cross-file dependency).
static AssetTypeValueField? FindTransformComponent(AssetsManager manager, AssetsFileInstance goFile, AssetTypeValueField goField, out AssetsFileInstance resultFile)
{
    resultFile = goFile;
    var componentArray = goField["m_Component"]["Array"];
    foreach (var entry in componentArray.Children)
    {
        var pptrField = entry.Children.FirstOrDefault(c => c.FieldName == "second")
            ?? entry.Children.FirstOrDefault(c => c.FieldName == "component")
            ?? entry;
        if (pptrField.Children.FirstOrDefault(c => c.FieldName == "m_PathID") == null) continue;

        var infoExt = manager.GetExtAsset(goFile, pptrField, true);
        if (infoExt.info == null) continue;
        if (infoExt.info.TypeId != ClassId_RectTransform && infoExt.info.TypeId != ClassId_Transform) continue;

        var full = manager.GetExtAsset(goFile, pptrField);
        resultFile = full.file;
        return full.baseField;
    }
    return null;
}

static string FindDataDir(string gamePath)
{
    // Unity names this folder "<ExeName>_Data"; the exe name (and so this folder)
    // changes across game updates/rebrands, so don't hardcode it.
    var candidates = Directory.GetDirectories(gamePath, "*_Data")
        .Where(d => Directory.Exists(Path.Combine(d, "StreamingAssets")))
        .ToList();

    if (candidates.Count == 1)
    {
        return candidates[0];
    }

    if (candidates.Count == 0)
    {
        throw new DirectoryNotFoundException($"No '*_Data' folder with a StreamingAssets subfolder found under {gamePath}");
    }

    // multiple candidates (e.g. a leftover from a previous version): prefer the one
    // matching an actual exe currently in the game folder.
    var matching = candidates
        .Where(d => File.Exists(Path.Combine(gamePath, Path.GetFileName(d)[..^"_Data".Length] + ".exe")))
        .ToList();

    if (matching.Count == 1)
    {
        return matching[0];
    }

    throw new InvalidOperationException(
        $"Multiple '*_Data' folders found under {gamePath} and couldn't tell which is active: " +
        string.Join(", ", candidates.Select(Path.GetFileName)));
}

static string FindRepoRoot(string startDir)
{
    var dir = new DirectoryInfo(startDir);
    while (dir != null)
    {
        if (Directory.Exists(Path.Combine(dir.FullName, "text", "translated")) &&
            Directory.Exists(Path.Combine(dir.FullName, "packed-mod")))
        {
            return dir.FullName;
        }
        dir = dir.Parent;
    }
    throw new DirectoryNotFoundException($"Couldn't find repo root (text/translated + packed-mod) above {startDir}");
}

static Config LoadConfig(string repoRoot)
{
    var configPath = Path.Combine(repoRoot, "tools", "asset-importer", "config.json");
    if (!File.Exists(configPath))
    {
        throw new FileNotFoundException(
            $"Missing {configPath}. Copy config.example.json to config.json and set your gamePath.");
    }

    var json = File.ReadAllText(configPath);
    var config = JsonSerializer.Deserialize<Config>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
    if (config == null || string.IsNullOrWhiteSpace(config.GamePath))
    {
        throw new InvalidDataException($"{configPath} is missing a valid gamePath.");
    }

    return config;
}

static Dictionary<string, string> LoadFontMapping(string path)
{
    if (!File.Exists(path))
    {
        return new Dictionary<string, string>();
    }

    var json = File.ReadAllText(path);
    var doc = JsonSerializer.Deserialize<FontMappingFile>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
    return doc?.Mappings.ToDictionary(m => m.Font, m => m.AtlasPng) ?? new Dictionary<string, string>();
}

record Config(string GamePath);
record ImportJob(string JsonPath, string DisplayName, string Container, long PathId, string? AtlasPngPath, bool IsDirectTexture = false);
record FontMappingEntry(string Font, string AtlasPng);
record FontMappingFile(List<FontMappingEntry> Mappings);
