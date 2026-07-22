// scripts/generate-card.js
// Entry point. Run with: node scripts/generate-card.js
// Requires env vars: ACCESS_TOKEN (GitHub PAT), USER_NAME (github username)

const fs = require('fs');
const path = require('path');
const api = require('./github-api');
const { computeLoc } = require('./loc-cache');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'profile.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Same dot-leader style as the rest of the card: pad label+dots to a fixed column. */
function dots(label, target = 24, minimum = 2) {
  const n = Math.max(minimum, target - label.length);
  return '.'.repeat(n);
}

/**
 * Builds the <text> rows for the Projects section from config.projects.
 * Rows start at y=530 (right under the "- Projects" header at y=510) and
 * step by 20px, matching every other section on the card. More than ~4
 * projects will start crowding the footer at y=620 -- if you add more,
 * bump the footer y and the canvas height/viewBox in both SVGs to match.
 */
function buildProjectsBlock(projects) {
  if (!projects || projects.length === 0) {
    return '  <text x="390" y="530"><tspan class="cc">. no projects listed -- edit config/profile.json</tspan></text>';
  }
  return projects
    .map((p, i) => {
      const y = 530 + i * 20;
      const name = escapeXml(p.name);
      const desc = escapeXml(p.description || '');
      return `  <text x="390" y="${y}"><tspan class="cc">. </tspan><tspan class="key">${name}</tspan><tspan class="cc">: ${dots(name)} </tspan><tspan class="value">${desc}</tspan></text>`;
    })
    .join('\n');
}

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

/** "coding since 2023-08-14 (2 years, 3 months, 9 days)" style uptime string. */
function upSince(createdAt) {
  const start = new Date(createdAt);
  const now = new Date();

  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  let days = now.getDate() - start.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const parts = [];
  if (years) parts.push(`${years}y`);
  if (months) parts.push(`${months}m`);
  parts.push(`${days}d`);
  return parts.join(' ');
}

function fillTemplate(template, values) {
  let out = template;
  for (const [key, val] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(val);
  }
  return out;
}

async function main() {
  const started = Date.now();
  console.log(`Generating profile card for ${api.USER_NAME}...`);

  const config = loadConfig();

  const user = await api.getUser(api.USER_NAME);
  const followers = await api.getFollowers(api.USER_NAME);

  const now = new Date();
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
  const contributions = await api.getContributions(yearStart, now.toISOString());
  const streaks = api.computeStreaks(contributions.days);

  const ownRepos = await api.getReposAndStars(['OWNER']);
  const allRepos = await api.getReposAndStars(['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER']);

  const reposForLoc = await api.getReposForLoc(['OWNER', 'COLLABORATOR', 'ORGANIZATION_MEMBER']);
  const loc = await computeLoc(api.USER_NAME, user.id, reposForLoc);

  if (config.projects && config.projects.length > 4) {
    console.warn(`config has ${config.projects.length} projects -- more than 4 may crowd the footer; check the rendered SVG.`);
  }

  const values = {
    // static, from config/profile.json -- edit that file, not the SVGs
    OS: escapeXml(config.system.os),
    EDITOR: escapeXml(config.system.editor),
    SHELL: escapeXml(config.system.shell),
    LANG_BACKEND: escapeXml(config.languages.backend),
    LANG_FRONTEND: escapeXml(config.languages.frontend),
    LANG_DATABASE: escapeXml(config.languages.database),
    LANG_TOOLS: escapeXml(config.languages.tools),
    EMAIL: escapeXml(config.contact.email),
    GITHUB: escapeXml(config.contact.github),
    LINKEDIN: escapeXml(config.contact.linkedin),
    PROJECTS_BLOCK: buildProjectsBlock(config.projects),

    // live, from the GitHub API
    AGE_DATA: upSince(user.createdAt),
    COMMIT_DATA: `${formatNumber(contributions.totalCommits)} (${now.getUTCFullYear()})`,
    REPO_DATA: formatNumber(ownRepos.totalCount),
    CONTRIB_DATA: formatNumber(allRepos.totalCount),
    STAR_DATA: formatNumber(ownRepos.totalStars),
    FOLLOWER_DATA: formatNumber(followers),
    PR_DATA: formatNumber(contributions.totalPRs),
    ISSUE_DATA: formatNumber(contributions.totalIssues),
    STREAK_CURRENT: `${streaks.current} day${streaks.current === 1 ? '' : 's'}`,
    STREAK_LONGEST: `${streaks.longest} day${streaks.longest === 1 ? '' : 's'}`,
    LOC_DATA: formatNumber(loc.netLoc),
    LOC_ADD: formatNumber(loc.additions),
    LOC_DEL: formatNumber(loc.deletions),
    LAST_SYNCED: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  };

  for (const mode of ['dark', 'light']) {
    const templatePath = path.join(ASSETS_DIR, `card_${mode}.svg`);
    const template = fs.readFileSync(templatePath, 'utf8');
    const filled = fillTemplate(template, values);
    fs.writeFileSync(path.join(__dirname, '..', `card_${mode}.svg`), filled);
    console.log(`  wrote card_${mode}.svg`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`Done in ${elapsed}s. LOC ${loc.fromCache ? '(all cached)' : '(recomputed some repos)'}.`);
  console.log('GraphQL calls:', api.queryCount, '| total:', Object.values(api.queryCount).reduce((a, b) => a + b, 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
