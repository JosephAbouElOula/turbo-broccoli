/**
 * AI vs Human attribution for a PR.
 * - Computes % from commits (based on added lines).
 * - Parses Declared AI% from the PR body (tolerant parser).
 * - If event payload body is stale/missing, refetches via GitHub API.
 * - Validates Declared AI% is an integer in 0..100 (fails job if invalid/missing).
 * - Final AI% = max(Computed, Declared).
 * - Emits Markdown for a single PR comment and a concise job summary via GITHUB_ENV.
 *
 * Requirements in the workflow:
 *   - actions/checkout@v4 with fetch-depth: 0
 *   - Provide GITHUB_TOKEN env to this step (env: GITHUB_TOKEN: ${{ github.token }})
 *
 * Outputs written to GITHUB_ENV:
 *   - ATTRIBUTION_MD   : Markdown for the PR comment (marker used for idempotent updates)
 *   - ATTRIBUTION_SUMMARY : One-line summary for the job
 */

const { execSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !fs.existsSync(p)) {
    console.error('GITHUB_EVENT_PATH is missing; this script must run on a pull_request event.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const event = readEvent();
const pr = event.pull_request;
if (!pr) {
  console.error('This workflow expects a pull_request event with pull_request payload.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 1) Ensure we have both base and head locally, then enumerate commits in range
// -----------------------------------------------------------------------------
const repoFull = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repoFull.split('/');

// Prefer exact SHAs from payload to avoid ambiguity
const baseSha = (pr.base && pr.base.sha) ? pr.base.sha : null;
const headSha = (pr.head && pr.head.sha) ? pr.head.sha : sh('git rev-parse HEAD');

// Make sure base exists locally (checkout step should fetch origin, but be safe)
try {
  if (baseSha) {
    // Create a local ref for the base SHA without altering the working tree
    sh(`git cat-file -e ${baseSha}^{commit} || git fetch --no-tags --prune --depth=0 origin +${baseSha}:${baseSha}`);
  }
} catch (e) {
  console.error('Warning: failed to fetch base SHA locally:', e.message || e);
}

if (!baseSha) {
  console.error('Could not resolve base SHA from event payload.');
  process.exit(1);
}
if (!headSha) {
  console.error('Could not resolve head SHA.');
  process.exit(1);
}

// List commits strictly in base..head (exclude base itself)
let commits = [];
try {
  commits = sh(`git rev-list ${baseSha}..${headSha}`).split('\n').filter(Boolean);
} catch (e) {
  console.error('Failed to list commits in PR range:', e.message || e);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 2) Classification: detect AI commits via author/committer or trailer "AI: true"
// -----------------------------------------------------------------------------
let aiAuthorPatterns = [
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
  for (const line of extra) {
    try { aiAuthorPatterns.push(new RegExp(line, 'i')); } catch {}
  }
}

function commitMeta(sha) {
  const fmt = ['%H', '%an', '%ae', '%cn', '%ce'].join('%n');
  const out = sh(`git show -s --format=${fmt} ${sha}`).split('\n');
  return {
    sha: out[0],
    authorName: out[1],
    authorEmail: out[2],
    committerName: out[3],
    committerEmail: out[4],
  };
}

function commitMessage(sha) {
  return sh(`git log -1 --pretty=%B ${sha}`);
}

function isAICommit(meta, message) {
  if (/^\s*AI:\s*true\s*$/im.test(message)) return true;
  return aiAuthorPatterns.some(re =>
    re.test(meta.authorName) ||
    re.test(meta.authorEmail) ||
    re.test(meta.committerName) ||
    re.test(meta.committerEmail)
  );
}

function addedLines(sha) {
  const out = sh(`git show --numstat --format= ${sha}`);
  let added = 0;
  if (!out) return 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (m && m[1] !== '-' && m[2] !== '-') {
      added += parseInt(m[1], 10);
    }
  }
  return added;
}

// Aggregate across commits
let aiAdded = 0;
let humanAdded = 0;
const details = [];

for (const c of commits) {
  const meta = commitMeta(c);
  const msg = commitMessage(c);
  const added = addedLines(c);
  const ai = isAICommit(meta, msg);
  if (ai) aiAdded += added; else humanAdded += added;
  details.push({
    sha: c,
    author: `${meta.authorName} <${meta.authorEmail}>`,
    added,
    label: ai ? 'AI' : 'Human'
  });
}

const totalAdded = aiAdded + humanAdded;
const computedPct = totalAdded === 0 ? 0 : Math.round((aiAdded / totalAdded) * 100);

// -----------------------------------------------------------------------------
// 3) Parse Declared AI% from PR body (tolerant) + API fallback if needed
// -----------------------------------------------------------------------------
function parseDeclared(body) {
  if (!body) return null;

  // Tolerant Declared matcher:
  //  - optional bold **...**
  //  - different dash characters
  //  - optional whitespace and optional trailing %
  const declRe =
    /(?:\*\*)?\s*Declared[\-\u2010-\u2015\u2212]AI[\-\u2010-\u2015\u2212]Percent(?:\*\*)?\s*:\s*([0-9]{1,3})\s*%?\s*/i;

  // Friendly "Estimated %" fallback
  const estRe = /Estimated\s*%[^0-9]*([0-9]{1,3})/i;

  const m = body.match(declRe) || body.match(estRe);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

let prBody = (pr.body || '').trim();
let declaredPct = parseDeclared(prBody);

// Payload can be stale on some events (e.g., synchronize). Refetch body via API if not found.
if ((declaredPct === null || Number.isNaN(declaredPct)) && process.env.GITHUB_TOKEN && owner && repo) {
  try {
    const curlCmd = [
      'curl -sS',
      `-H "Authorization: Bearer ${process.env.GITHUB_TOKEN}"`,
      '-H "Accept: application/vnd.github+json"',
      `"https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}"`
    ].join(' ');
    const out = sh(curlCmd);
    const fresh = JSON.parse(out);
    const freshBody = (fresh && fresh.body ? fresh.body : '').trim();
    declaredPct = parseDeclared(freshBody);
  } catch (e) {
    console.error('Warning: failed to refetch PR body from GitHub API:', e.message || e);
  }
}

// Validate Declared 0..100
if (declaredPct === null || declaredPct < 0 || declaredPct > 100) {
  console.error(
    'Declared AI% is missing or invalid. Provide a single integer 0..100 in the PR body, e.g.:\n' +
    '**Declared-AI-Percent:** 60'
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 4) Final % and outputs
// -----------------------------------------------------------------------------
const finalPct = Math.max(computedPct, declaredPct);
const marker = '<!-- ai-attribution-marker -->';

const md = `${marker}
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

const summary = `Computed ${computedPct}% · Declared ${declaredPct}% · Final ${finalPct}% (${baseSha.slice(0,7)}..${headSha.slice(0,7)})`;

// Export to next steps
const envFile = process.env.GITHUB_ENV;
if (!envFile) {
  console.error('GITHUB_ENV is not set; cannot pass data to subsequent steps.');
  process.exit(1);
}
fs.appendFileSync(envFile, `\nATTRIBUTION_MD<<EOF\n${md}\nEOF\n`);
fs.appendFileSync(envFile, `ATTRIBUTION_SUMMARY=${summary}\n`);

console.log(summary);
