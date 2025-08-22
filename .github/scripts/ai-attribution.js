/**
 * AI vs Human attribution for a PR.
 * - Computes % from commits using (added + deleted) line volume.
 * - Parses Declared AI% from PR body (**Declared-AI-Percent**: N) with colon outside bold.
 * - Refetches PR body via API if event payload is stale.
 * - Validates Declared 0..100 (fails job if invalid/missing).
 * - Final AI% = max(Computed, Declared).
 * - Exports Markdown (ATTRIBUTION_MD) and a summary (ATTRIBUTION_SUMMARY) via GITHUB_ENV.
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
    console.error('GITHUB_EVENT_PATH is missing; run on pull_request.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const event = readEvent();
const pr = event.pull_request;
if (!pr) {
  console.error('Expected pull_request payload.');
  process.exit(1);
}

// --- Ensure base/head SHAs exist locally and enumerate commits in base..head
const repoFull = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repoFull.split('/');

const baseSha = (pr.base && pr.base.sha) ? pr.base.sha : null;
const headSha = (pr.head && pr.head.sha) ? pr.head.sha : sh('git rev-parse HEAD');

try {
  if (baseSha) {
    sh(`git cat-file -e ${baseSha}^{commit} || git fetch --no-tags --prune --depth=0 origin +${baseSha}:${baseSha}`);
  }
} catch (e) {
  console.error('Warning: could not ensure base SHA locally:', e.message || e);
}

if (!baseSha) { console.error('Missing base SHA.'); process.exit(1); }
if (!headSha) { console.error('Missing head SHA.'); process.exit(1); }

let commits = [];
try {
  commits = sh(`git rev-list ${baseSha}..${headSha}`).split('\n').filter(Boolean);
} catch (e) {
  console.error('Failed to list PR commits:', e.message || e);
  process.exit(1);
}

// --- Classification rules (author/bot patterns + strict trailer)
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
    .split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of extra) {
    try { aiAuthorPatterns.push(new RegExp(line, 'i')); } catch {}
  }
}

function commitMeta(sha) {
  const fmt = ['%H','%an','%ae','%cn','%ce'].join('%n');
  const out = sh(`git show -s --format=${fmt} ${sha}`).split('\n');
  return { sha: out[0], authorName: out[1], authorEmail: out[2], committerName: out[3], committerEmail: out[4] };
}
function commitMessage(sha) { return sh(`git log -1 --pretty=%B ${sha}`); }

// STRICT trailer: a standalone line "AI: true" (avoids accidental matches in prose)
function hasAIMarker(message) {
  // Accepts "AI: true", "AI:true", "AI:True" anywhere in commit message
  return /\bAI\s*:\s*true\b/i.test(message);
}

function isAICommit(meta, message) {
  if (hasAIMarker(message)) return true;
  return aiAuthorPatterns.some(re =>
    re.test(meta.authorName) || re.test(meta.authorEmail) ||
    re.test(meta.committerName) || re.test(meta.committerEmail)
  );
}


// --- Diff volume per commit: (added + deleted) across files (ignores binary lines '-')
function changedLines(sha) {
  const out = sh(`git show --numstat --format= ${sha}`);
  let changed = 0;
  if (!out) return 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (!m) continue;
    const a = (m[1] === '-') ? 0 : parseInt(m[1], 10);
    const d = (m[2] === '-') ? 0 : parseInt(m[2], 10);
    if (!Number.isNaN(a)) changed += a;
    if (!Number.isNaN(d)) changed += d;
  }
  return changed;
}

// --- Aggregate volume across commits into AI vs Human buckets
let aiVol = 0, humanVol = 0;
const details = [];

for (const c of commits) {
  const meta = commitMeta(c);
  const msg = commitMessage(c);
  const vol = changedLines(c);               // <-- FIX: counts edits & deletes too
  const ai = isAICommit(meta, msg);
  if (ai) aiVol += vol; else humanVol += vol;
  details.push({ sha: c, author: `${meta.authorName} <${meta.authorEmail}>`, volume: vol, label: ai ? 'AI' : 'Human' });
}

const totalVol = aiVol + humanVol;
const computedPct = totalVol === 0 ? 0 : Math.round((aiVol / totalVol) * 100);

// --- Parse Declared from PR body (colon OUTSIDE bold)
function parseDeclared(body) {
  if (!body) return null;

  // Matches: **Declared-AI-Percent**: 40   (colon outside bold, optional %)
  const declStrict =
    /(?:\*\*)\s*Declared[\-\u2010-\u2015\u2212]AI[\-\u2010-\u2015\u2212]Percent\s*(?:\*\*)\s*:\s*([0-9]{1,3})\s*%?\s*/i;

  // Fallback: "Estimated % ... 40"
  const declAlt = /Estimated\s*%[^0-9]*([0-9]{1,3})/i;

  const m = body.match(declStrict) || body.match(declAlt);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

let prBody = (pr.body || '').trim();
let declaredPct = parseDeclared(prBody);

// Refetch PR body if payload stale
if ((declaredPct === null || Number.isNaN(declaredPct)) && process.env.GITHUB_TOKEN && owner && repo) {
  try {
    const out = sh([
      'curl -sS',
      `-H "Authorization: Bearer ${process.env.GITHUB_TOKEN}"`,
      '-H "Accept: application/vnd.github+json"',
      `"https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}"`
    ].join(' '));
    const fresh = JSON.parse(out);
    const freshBody = (fresh && fresh.body ? fresh.body : '').trim();
    declaredPct = parseDeclared(freshBody);
  } catch (e) {
    console.error('Warning: refetch PR body failed:', e.message || e);
  }
}

// Validate Declared 0..100
if (declaredPct === null || declaredPct < 0 || declaredPct > 100) {
  console.error(
    'Declared AI% is missing or invalid. Provide a single integer 0..100 in the PR body, e.g.:\n' +
    '**Declared-AI-Percent**: 60'
  );
  process.exit(1);
}

// --- Final and outputs
const finalPct = Math.max(computedPct, declaredPct);
const marker = '<!-- ai-attribution-marker -->';

const md = `${marker}
**AI Attribution (recomputed at HEAD):**

- **Computed AI% (by diff volume):** ${computedPct}%
- **Declared AI% (from PR body):** ${declaredPct}%
- **Final AI% (max of both):** ${finalPct}%

- AI diff volume (added+deleted): ${aiVol}
- Human diff volume (added+deleted): ${humanVol}
- Total diff volume: ${totalVol}

<details><summary>Per-commit details</summary>

| Commit | Author | Changed (±) | Label |
|---|---|---:|---|
${details.map(d => `| \`${d.sha.slice(0,7)}\` | ${d.author} | ${d.volume} | ${d.label} |`).join('\n')}
</details>
`;

const summary = `Computed ${computedPct}% · Declared ${declaredPct}% · Final ${finalPct}% (${baseSha.slice(0,7)}..${headSha.slice(0,7)})`;

// Export to env for YAML step
const envFile = process.env.GITHUB_ENV;
if (!envFile) { console.error('GITHUB_ENV missing.'); process.exit(1); }
fs.appendFileSync(envFile, `\nATTRIBUTION_MD<<EOF\n${md}\nEOF\n`);
fs.appendFileSync(envFile, `ATTRIBUTION_SUMMARY=${summary}\n`);

console.log(summary);
