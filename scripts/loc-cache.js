// scripts/loc-cache.js
// Total lines-of-code is expensive to compute (it means walking every commit
// of every repo). We cache a per-repo snapshot keyed by commit count: if a
// repo's commit count hasn't changed since last run, we trust the cached
// numbers instead of re-fetching. This is the same trick Andrew6rant's
// today.py uses, just stored as JSON instead of a hand-rolled text format.

const fs = require('fs');
const path = require('path');
const { getRepoLoc } = require('./github-api');

const CACHE_DIR = path.join(__dirname, '..', 'cache');

function cachePath(username) {
  return path.join(CACHE_DIR, `${username}.json`);
}

function loadCache(username) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(username), 'utf8'));
  } catch {
    return {}; // first run, or file doesn't exist yet
  }
}

function saveCache(username, cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(username), JSON.stringify(cache, null, 2));
}

/**
 * repos: [{ node: { nameWithOwner, defaultBranchRef: { target: { history: { totalCount } } } } }]
 * Returns { additions, deletions, netLoc, fromCache: bool }
 */
async function computeLoc(username, ownerId, repos) {
  const cache = loadCache(username);
  let anyRefetched = false;
  let additions = 0;
  let deletions = 0;

  for (const { node } of repos) {
    const commitTotal = node.defaultBranchRef?.target?.history?.totalCount ?? 0;
    const cached = cache[node.nameWithOwner];

    if (cached && cached.commitTotal === commitTotal) {
      additions += cached.additions;
      deletions += cached.deletions;
      continue;
    }

    // Repo is new or has new commits since last run -> re-walk it.
    anyRefetched = true;
    const [owner, repoName] = node.nameWithOwner.split('/');
    const result = commitTotal === 0
      ? { add: 0, del: 0 }
      : await getRepoLoc(owner, repoName, ownerId);

    cache[node.nameWithOwner] = {
      commitTotal,
      additions: result.add,
      deletions: result.del,
    };
    additions += result.add;
    deletions += result.del;
  }

  saveCache(username, cache);
  return {
    additions,
    deletions,
    netLoc: additions - deletions,
    fromCache: !anyRefetched,
  };
}

module.exports = { computeLoc };
