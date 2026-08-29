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

// "<name>-<CAB-hash or file.assets>-<pathId>.<json|txt|png>"
var pattern = new Regex(@"^(?<name>.+)-(?<container>CAB-[0-9a-fA-F]{32}|[^\\/]+\.assets)-(?<pathid>-?\d+)\.(?<ext>json|txt|png)$");

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

// resolve each job's container to either a bundle file, or a direct "<file>.assets" in dataDir
var bundleFiles = Directory.Exists(bundlesRoot)
    ? Directory.GetFiles(bundlesRoot, "*", SearchOption.AllDirectories)
        .Where(f => !f.EndsWith(".manifest", StringComparison.OrdinalIgnoreCase)).ToList()
    : new List<string>();

var directContainers = new HashSet<string>(jobs.Select(j => j.Container).Where(c => c.EndsWith(".assets")));
var bundleContainers = new HashSet<string>(jobs.Select(j => j.Container).Where(c => !c.EndsWith(".assets")));

Console.WriteLine("\nLocating containers...");
var containerToBundle = new Dictionary<string, string>();
foreach (var container in bundleContainers)
{
    string? found = bundleFiles.FirstOrDefault(f => BundleContainsEntry(f, container));
    if (found == null)
    {
        Console.WriteLine($"ERROR: couldn't find any bundle under {bundlesRoot} containing {container}");
        return 1;
    }
    containerToBundle[container] = found;
    Console.WriteLine($"  {container} -> {Path.GetRelativePath(bundlesRoot, found)} (bundle)");
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

// Cpp2IL is only needed for direct files without an embedded type tree, and it's slow to
// set up (parses the game's whole IL2CPP binary) - build it at most once per run and share it.
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
        Console.WriteLine("  (setting up IL2CPP metadata for a direct-file import - this takes a moment)");
        sharedCpp2Il = new Cpp2IlTempGenerator(metaPath, asmPath);
    }
    return sharedCpp2Il;
}

var touchedFiles = new List<string>();

// ============ bundle-hosted jobs ============
foreach (var group in jobs.Where(j => containerToBundle.ContainsKey(j.Container)).GroupBy(j => containerToBundle[j.Container]))
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

    foreach (var containerGroup in group.GroupBy(j => j.Container))
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
    if (info == null)
    {
        Console.WriteLine($"  ERROR: pathId {job.PathId} ({job.DisplayName}) not found in {job.Container}");
        return false;
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
