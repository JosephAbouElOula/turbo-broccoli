/**
 * AI vs Human attribution for a PR.
 * - Computes % from commits (added lines).
 * - Parses Declared AI% from PR body.
 * - Validates 0..100 and fails the job if invalid/missing.
 * - Exposes a Markdown comment + check summary via GITHUB_ENV.
 *
 * Inputs from the GitHub Actions runtime:
 *  - GITHUB_EVENT_PATH (JSON payload; contains pull_request with body & number)
 *  - GITHUB_BASE_REF (PR base)
 *  - GITHUB_SHA / HEAD
 */

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('path');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !fs.existsSync(p)) {
    console.error('GITHUB_EVENT_PATH is missing; this script must run on a pull_request event.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- 1) Gather PR context & body (for declared %) ---
const event = readEvent();
const pr = event.pull_request;
if (!pr) {
  console.error('This workflow step expects a pull_request event with pull_request payload.');
  process.exit(1);
}
const prBody = (pr.body || '').trim();

// --- 2) Compute commit range & list commits in PR ---
const baseSha = process.env.GITHUB_BASE_REF
  ? sh(`git rev-parse origin/${process.env.GITHUB_BASE_REF}`)
  : (() => {
      // Fallback: try to locate merge-base with default branch if base ref not set
      try { return sh('git merge-base HEAD HEAD^'); } catch { return sh('git rev-parse HEAD^'); }
    })();

const headSha = sh('git rev-parse HEAD');
const commits = sh(`git rev-list ${baseSha}..${headSha}`)
  .split('\n')
  .filter(Boolean);

// --- 3) AI author patterns (augmentable by .github/ai-authors.txt) ---
let patterns = [
  /codex/i,
  /copilot/i,
  /chatgpt/i,
  /openai/i,
  /\[bot\]/i
];
const extraPatternsFile = path.join('.github', 'ai-authors.txt');
if (fs.existsSync(extraPatternsFile)) {
  const extra = fs.readFileSync(extraPatternsFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  for (const line of extra) patterns.push(new RegExp(line, 'i'));
}

function commitMeta(sha) {
  const format = ['%H','%an','%ae','%cn','%ce'].join('%n');
  const out = sh(`git show -s --format=${format} ${sha}`).split('\n');
  return {
    sha: out[0],
    authorName: out[1], authorEmail: out[2],
    committerName: out[3], committerEmail: out[4]
  };
}

function isAICommit(meta, message) {
  if (/^\s*AI:\s*true\s*$/im.test(message)) return true;
  return patterns.some(re =>
    re.test(meta.authorName) || re.test(meta.authorEmail) ||
    re.test(meta.committerName) || re.test(meta.committerEmail)
  );
}

function addedLines(sha) {
  const out = sh(`git show --numstat --format= ${sha}`);
  let added = 0;
  out.split('\n').forEach(line => {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (m && m[1] !== '-' && m[2] !== '-') {
      added += parseInt(m[1], 10);
    }
  });
  return added;
}

// --- 4) Aggregate AI vs Human added lines across PR commits ---
let aiAdded = 0;
let humanAdded = 0;
let details = [];

for (const c of commits) {
  const meta = commitMeta(c);
  const msg = sh(`git log -1 --pretty=%B ${c}`);
  const added = addedLines(c);
  const isAI = isAICommit(meta, msg);
  if (isAI) aiAdded += added; else humanAdded += added;
  details.push({
    sha: c,
    author: `${meta.authorName} <${meta.authorEmail}>`,
    added,
    label: isAI ? 'AI' : 'Human'
  });
}

const totalAdded = aiAdded + humanAdded;
const computedPct = totalAdded === 0 ? 0 : Math.round((aiAdded / totalAdded) * 100);

// --- 5) Parse Declared AI% from PR body (two tolerant formats) ---
// a) Strict: **Declared-AI-Percent:** 60
// b) Friendly: "Estimated % of new/changed code from AI (0–100): 60"
let declaredPct = null;
let match =
  prBody.match(/Declared-AI-Percent:\s*([0-9]{1,3})/i) ||
  prBody.match(/Estimated\s*%[^0-9]*([0-9]{1,3})/i);

if (match) {
  declaredPct = parseInt(match[1], 10);
  if (Number.isNaN(declaredPct)) declaredPct = null;
}

// --- 6) Validation: Declared % must exist and be 0..100 ---
if (declaredPct === null || declaredPct < 0 || declaredPct > 100) {
  console.error(
    `Declared AI% is missing or invalid. ` +
    `Provide a single integer 0..100 in the PR body, e.g.:\n` +
    `**Declared-AI-Percent:** 60`
  );
  process.exit(1);
}

// --- 7) Final % = max(Computed, Declared) ---
const finalPct = Math.max(computedPct, declaredPct);
const humanPct = 100 - finalPct;

// --- 8) Prepare Markdown comment & job summary ---
const marker = '<!-- ai-attribution-marker -->';
const md =
`${marker}
**AI Attribution (recomputed at HEAD):**

- **Computed AI%:** ${computedPct}%
- **Declared AI% (from PR body):** ${declaredPct}%
- **Final AI% (max of both):** ${finalPct}%

- AI-added lines (computed): ${aiAdded} (${computedPct}%)
- Human-added lines (computed): ${humanAdded} (${100 - computedPct}%)
- Total added lines: ${totalAdded}

<details><summary>Per-commit details</summary>

| Commit | Author | Added | Label |
|---|---|---:|---|
${details.map(d => `| \`${d.sha.slice(0,7)}\` | ${d.author} | ${d.added} | ${d.label} |`).join('\n')}
</details>
`;

const summary = `Computed ${computedPct}% · Declared ${declaredPct}% · Final ${finalPct}% (base..head ${baseSha.slice(0,7)}..${headSha.slice(0,7)})`;

// --- 9) Export to GITHUB_ENV so the next step can post/update the comment ---
const envFile = process.env.GITHUB_ENV;
if (!envFile) {
  console.error('GITHUB_ENV is not set; cannot pass data to next step.');
  process.exit(1);
}
fs.appendFileSync(envFile, `\nATTRIBUTION_MD<<EOF\n${md}\nEOF\n`);
fs.appendFileSync(envFile, `ATTRIBUTION_SUMMARY=${summary}\n`);

console.log(summary);
