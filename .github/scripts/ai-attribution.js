// Recomputes AI vs Human attribution for the current PR by summing added lines per commit.
// Classification rules:
// 1) Author or committer includes known AI patterns (codex, copilot, chatgpt, openai, [bot]) -> AI
// 2) Commit trailer "AI: true" (case-insensitive) -> AI
// 3) Otherwise -> Human
//
// You can refine patterns by editing .github/ai-authors.txt (one regex per line).

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// Get base..head for the PR
const base = process.env.GITHUB_BASE_REF
  ? sh(`git rev-parse origin/${process.env.GITHUB_BASE_REF}`)
  : sh('git merge-base HEAD HEAD^'); // fallback for safety

const head = sh('git rev-parse HEAD');

// Collect commits in PR range (exclude merge-base)
const commits = sh(`git rev-list ${base}..${head}`).split('\n').filter(Boolean);

// Load author patterns
let patterns = [
  /codex/i,
  /copilot/i,
  /chatgpt/i,
  /openai/i,
  /\[bot\]/i
];

const extraFile = path.join('.github', 'ai-authors.txt');
if (fs.existsSync(extraFile)) {
  const extra = fs.readFileSync(extraFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of extra) patterns.push(new RegExp(line, 'i'));
}

function isAICommit(meta, message) {
  if (/^\s*AI:\s*true\s*$/im.test(message)) return true;
  return patterns.some(re =>
    re.test(meta.authorName) || re.test(meta.authorEmail) || re.test(meta.committerName) || re.test(meta.committerEmail)
  );
}

function commitMeta(sha) {
  const format = [
    '%H', '%an', '%ae', '%cn', '%ce' // sha, author name/email, committer name/email
  ].join('%n');
  const out = sh(`git show -s --format=${format} ${sha}`).split('\n');
  return {
    sha: out[0],
    authorName: out[1], authorEmail: out[2],
    committerName: out[3], committerEmail: out[4]
  };
}

function numstat(sha) {
  // Sum "added" across files (ignoring deletions for percentage to reflect new code volume)
  const out = sh(`git show --numstat --format= ${sha}`); // blank format omits commit header
  let added = 0;
  out.split('\n').forEach(line => {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (m && m[1] !== '-' && m[2] !== '-') {
      added += parseInt(m[1], 10);
    }
  });
  return added;
}

let aiAdded = 0;
let humanAdded = 0;
let details = [];

for (const c of commits) {
  const meta = commitMeta(c);
  const added = numstat(c);
  const msg = sh(`git log -1 --pretty=%B ${c}`);
  const ai = isAICommit(meta, msg);
  if (ai) aiAdded += added; else humanAdded += added;

  details.push({
    sha: c,
    author: `${meta.authorName} <${meta.authorEmail}>`,
    added,
    label: ai ? 'AI' : 'Human'
  });
}

const total = aiAdded + humanAdded;
const aiPct = total === 0 ? 0 : Math.round((aiAdded / total) * 100);
const humanPct = 100 - aiPct;

// Prepare Markdown comment & summary
const marker = '<!-- ai-attribution-marker -->';
const md = `${marker}
**AI Attribution (recomputed at HEAD):**

- AI-added lines: **${aiAdded}** (${aiPct}%)
- Human-added lines: **${humanAdded}** (${humanPct}%)
- Total added lines: **${total}**

<details><summary>Per-commit details</summary>

| Commit | Author | Added | Label |
|---|---|---:|---|
${details.map(d => `| \`${d.sha.slice(0,7)}\` | ${d.author} | ${d.added} | ${d.label} |`).join('\n')}
</details>
`;

const summary = `AI ${aiPct}% · Human ${humanPct}% (added lines across PR range ${base.slice(0,7)}..${head.slice(0,7)})`;

process.env.ATTRIBUTION_MD = md;
process.env.ATTRIBUTION_SUMMARY = summary;

// Export for next step
const envFile = process.env.GITHUB_ENV;
fs.appendFileSync(envFile, `\nATTRIBUTION_MD<<EOF\n${md}\nEOF\n`);
fs.appendFileSync(envFile, `ATTRIBUTION_SUMMARY=${summary}\n`);
console.log(summary);
