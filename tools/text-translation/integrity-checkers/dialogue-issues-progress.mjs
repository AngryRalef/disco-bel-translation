import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_OWNER = 'AngryRalef';
const DEFAULT_REPO = 'disco-bel-translation';

function parseArgs(argv) {
  const result = {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    output: null,
    token: process.env.GITHUB_TOKEN || ''
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--owner' && argv[i + 1]) {
      result.owner = argv[++i];
    } else if (arg === '--repo' && argv[i + 1]) {
      result.repo = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      result.output = argv[++i];
    } else if (arg === '--token' && argv[i + 1]) {
      result.token = argv[++i];
    }
  }

  return result;
}

function countWords(text) {
  if (typeof text !== 'string') {
    return 0;
  }

  const tokens = text
    .trim()
    .split(/[^\p{L}\p{N}'’-]+/u)
    .filter(Boolean);

  return tokens.length;
}

function countWordsInAlternateObject(node, language) {
  if (!node || typeof node !== 'object') {
    return 0;
  }

  let words = 0;

  if (typeof node[language] === 'string') {
    words += countWords(node[language]);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      words += countWordsInAlternateObject(value, language);
    }
  }

  return words;
}

function countWordsInNode(node) {
  if (!node || typeof node !== 'object') {
    return { englishWords: 0, belarusianWords: 0 };
  }

  const englishSource = typeof node.english === 'string'
    ? node.english
    : (typeof node.text === 'string' ? node.text : '');

  let englishWords = countWords(englishSource);
  let belarusianWords = countWords(node.belarusian);

  if (node.alternates && typeof node.alternates === 'object') {
    englishWords += countWordsInAlternateObject(node.alternates, 'english');
    belarusianWords += countWordsInAlternateObject(node.alternates, 'belarusian');
  }

  if (Array.isArray(node.links)) {
    for (const child of node.links) {
      const childCount = countWordsInNode(child);
      englishWords += childCount.englishWords;
      belarusianWords += childCount.belarusianWords;
    }
  }

  return { englishWords, belarusianWords };
}

function collectDialogueFiles(dialoguesDir) {
  const entries = fs.readdirSync(dialoguesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function analyzeDialogueFile(filePath) {
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let englishWords = 0;
  let belarusianWords = 0;

  if (Array.isArray(content.dialogueTree)) {
    for (const node of content.dialogueTree) {
      const rowWords = countWordsInNode(node);
      englishWords += rowWords.englishWords;
      belarusianWords += rowWords.belarusianWords;
    }
  }

  return { englishWords, belarusianWords };
}

function toIssueKey(dialogueId) {
  return `dialogue-${String(dialogueId).padStart(3, '0')}`;
}

async function fetchIssuesPage({ owner, repo, token, page }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`;

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dialogue-issues-progress-script'
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    headers
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API request failed (status ${response.status}): ${message}`);
  }

  return response.json();
}

async function fetchAllDialogueIssues({ owner, repo, token }) {
  const issueStateByDialogueId = new Map();

  for (let page = 1; page <= 100; page++) {
    const issues = await fetchIssuesPage({ owner, repo, token, page });
    if (!Array.isArray(issues) || issues.length === 0) {
      break;
    }

    for (const issue of issues) {
      if (issue.pull_request) {
        continue;
      }

      const match = /^dialogue-(\d{1,3})$/i.exec(issue.title || '');
      if (!match) {
        continue;
      }

      const dialogueId = Number.parseInt(match[1], 10);
      const current = issueStateByDialogueId.get(dialogueId) || {
        key: toIssueKey(dialogueId),
        states: new Set(),
        issueNumbers: []
      };

      current.states.add(issue.state === 'closed' ? 'closed' : 'open');
      current.issueNumbers.push(issue.number);
      issueStateByDialogueId.set(dialogueId, current);
    }
  }

  return issueStateByDialogueId;
}

function resolveDialogueStatus(issueInfo) {
  if (!issueInfo) {
    return 'missing';
  }

  if (issueInfo.states.has('closed')) {
    return 'closed';
  }

  return 'open';
}

function toPercent(numerator, denominator) {
  if (denominator === 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

async function execute() {
  const args = parseArgs(process.argv.slice(2));

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(scriptDir, '..', '..', '..');
  const dialoguesDir = path.resolve(rootDir, 'text', 'dialogues');
  const outputPath = args.output
    ? path.resolve(rootDir, args.output)
    : path.resolve(rootDir, 'text', 'dialogue-issues-progress.json');

  const dialogueFiles = collectDialogueFiles(dialoguesDir);
  if (!args.token) {
    console.log('No GitHub token found. Continuing with unauthenticated GitHub API requests.');
  }

  const issueStateByDialogueId = await fetchAllDialogueIssues({
    owner: args.owner,
    repo: args.repo,
    token: args.token
  });

  let totalEnglishWords = 0;
  let totalBelarusianWords = 0;
  let closedEnglishWords = 0;
  let closedBelarusianWords = 0;
  let closedDialogues = 0;
  let openDialogues = 0;
  let missingDialogues = 0;

  const perDialogue = [];

  for (const fileName of dialogueFiles) {
    const dialogueId = Number.parseInt(fileName, 10);
    const issueInfo = issueStateByDialogueId.get(dialogueId);
    const status = resolveDialogueStatus(issueInfo);

    const filePath = path.join(dialoguesDir, fileName);
    const words = analyzeDialogueFile(filePath);

    totalEnglishWords += words.englishWords;
    totalBelarusianWords += words.belarusianWords;

    if (status === 'closed') {
      closedDialogues += 1;
      closedEnglishWords += words.englishWords;
      closedBelarusianWords += words.belarusianWords;
    } else if (status === 'open') {
      openDialogues += 1;
    } else {
      missingDialogues += 1;
    }

    perDialogue.push({
      dialogueId,
      issueKey: toIssueKey(dialogueId),
      status,
      issueNumbers: issueInfo ? issueInfo.issueNumbers : [],
      englishWords: words.englishWords,
      belarusianWords: words.belarusianWords
    });
  }

  const totalDialogues = dialogueFiles.length;
  const mappedDialogues = totalDialogues - missingDialogues;

  const result = {
    generatedAt: new Date().toISOString(),
    repository: {
      owner: args.owner,
      name: args.repo
    },
    source: {
      dialoguesPath: 'text/dialogues',
      dialogueCount: totalDialogues
    },
    issues: {
      closed: closedDialogues,
      open: openDialogues,
      missing: missingDialogues,
      mapped: mappedDialogues
    },
    words: {
      english: {
        total: totalEnglishWords,
        closed: closedEnglishWords,
        progressPercent: toPercent(closedEnglishWords, totalEnglishWords)
      },
      belarusian: {
        total: totalBelarusianWords,
        closed: closedBelarusianWords,
        progressPercent: toPercent(closedBelarusianWords, totalBelarusianWords)
      }
    },
    completion: {
      byDialoguesPercent: toPercent(closedDialogues, totalDialogues)
    },
    perDialogue
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

  console.log('Dialogue progress report generated');
  console.log(`Repository: ${args.owner}/${args.repo}`);
  console.log(`Dialogues: total=${totalDialogues}, closed=${closedDialogues}, open=${openDialogues}, missing=${missingDialogues}`);
  console.log(`English words: ${closedEnglishWords}/${totalEnglishWords} (${result.words.english.progressPercent}%)`);
  console.log(`Belarusian words: ${closedBelarusianWords}/${totalBelarusianWords} (${result.words.belarusian.progressPercent}%)`);
  console.log(`Output: ${outputPath}`);
}

execute().catch((error) => {
  console.error('Failed to build dialogue issue progress report.');
  console.error(error.message);
  process.exit(1);
});
