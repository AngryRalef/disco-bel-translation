// Headlessly imports the translated Lockit JSON dumps (text/translated/*.json)
// directly into the Spanish AssetBundle files inside the game's install folder,
// replacing the manual UABEANext GUI import step.
//
// Usage: dotnet run --project tools/asset-importer
// Requires tools/asset-importer/config.json (see config.example.json).

using System.Text.Json;
using System.Text.RegularExpressions;
using AssetImporter;
using AssetsTools.NET;
using AssetsTools.NET.Extra;

var toolDir = AppContext.BaseDirectory;
var repoRoot = FindRepoRoot(toolDir);
var config = LoadConfig(repoRoot);

var translatedDir = Path.Combine(repoRoot, "text", "translated");
var bundlesRoot = Path.Combine(config.GamePath, "disco_Data", "StreamingAssets", "AssetBundles", "Windows");

var pattern = new Regex(@"^(?<name>.+)-(?<container>CAB-[0-9a-fA-F]{32})-(?<pathid>-?\d+)\.json$");

var jobs = new List<ImportJob>();
foreach (var jsonPath in Directory.GetFiles(translatedDir, "*.json"))
{
    var match = pattern.Match(Path.GetFileName(jsonPath));
    if (!match.Success)
    {
        continue;
    }

    jobs.Add(new ImportJob(
        JsonPath: jsonPath,
        DisplayName: match.Groups["name"].Value,
        Container: match.Groups["container"].Value,
        PathId: long.Parse(match.Groups["pathid"].Value)
    ));
}

if (jobs.Count == 0)
{
    Console.WriteLine($"No matching '<name>-CAB-<hash>-<pathid>.json' files found in {translatedDir}");
    return 1;
}

Console.WriteLine($"Found {jobs.Count} translation file(s) to import:");
foreach (var job in jobs)
{
    Console.WriteLine($"  {job.DisplayName} -> {job.Container} @ {job.PathId}");
}

if (!Directory.Exists(bundlesRoot))
{
    Console.WriteLine($"ERROR: bundle folder not found: {bundlesRoot}");
    Console.WriteLine("Check gamePath in tools/asset-importer/config.json");
    return 1;
}

Console.WriteLine("\nLocating which bundle file hosts each container...");
var bundleFiles = Directory.GetFiles(bundlesRoot, "*", SearchOption.AllDirectories)
    .Where(f => !f.EndsWith(".manifest", StringComparison.OrdinalIgnoreCase))
    .ToList();

var containerToBundle = new Dictionary<string, string>();
foreach (var container in jobs.Select(j => j.Container).Distinct())
{
    string? found = null;
    foreach (var bundleFile in bundleFiles)
    {
        if (BundleContainsEntry(bundleFile, container))
        {
            found = bundleFile;
            break;
        }
    }

    if (found == null)
    {
        Console.WriteLine($"ERROR: couldn't find any bundle under {bundlesRoot} containing {container}");
        return 1;
    }

    containerToBundle[container] = found;
    Console.WriteLine($"  {container} -> {Path.GetRelativePath(bundlesRoot, found)}");
}

var jobsByBundle = jobs.GroupBy(j => containerToBundle[j.Container]);

foreach (var group in jobsByBundle)
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
        var refMan = manager.GetRefTypeManager(fileInst);

        foreach (var job in containerGroup)
        {
            var info = fileInst.file.GetAssetInfo(job.PathId);
            if (info == null)
            {
                Console.WriteLine($"  ERROR: pathId {job.PathId} ({job.DisplayName}) not found in {container}");
                return 1;
            }

            var tempField = manager.GetTemplateBaseField(fileInst, info);

            using var fs = File.OpenRead(job.JsonPath);
            var importer = new AssetImport(fs, refMan);
            var data = importer.ImportJsonAsset(tempField, out var err);

            if (data == null)
            {
                Console.WriteLine($"  IMPORT FAILED for {job.DisplayName}: {err}");
                return 1;
            }

            info.SetNewData(data);
            Console.WriteLine($"  imported {job.DisplayName} ({data.Length:N0} bytes)");
        }

        dirInfos[idx].SetNewData(fileInst.file);
    }

    var tempOutPath = liveBundlePath + ".tmp";
    using (var outStream = File.Create(tempOutPath))
    {
        bunInst.file.Write(new AssetsFileWriter(outStream));
    }

    try
    {
        File.Move(tempOutPath, liveBundlePath, overwrite: true);
    }
    catch (IOException ex)
    {
        Console.WriteLine($"  ERROR: couldn't replace {liveBundlePath} ({ex.Message}).");
        Console.WriteLine("  Is the game currently running and holding this file open? Close it and retry.");
        File.Delete(tempOutPath);
        return 1;
    }

    Console.WriteLine($"  wrote {Path.GetRelativePath(config.GamePath, liveBundlePath)}");
}

Console.WriteLine("\nDone.");
return 0;

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

record Config(string GamePath);
record ImportJob(string JsonPath, string DisplayName, string Container, long PathId);
