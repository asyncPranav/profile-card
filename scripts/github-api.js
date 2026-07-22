// scripts/github-api.js
// Thin wrapper around GitHub's GraphQL v4 API.
// Every exported function returns plain data — no SVG/formatting concerns here.

const GRAPHQL_URL = 'https://api.github.com/graphql';

const HEADERS = {
  Authorization: `bearer ${process.env.ACCESS_TOKEN}`,
  'Content-Type': 'application/json',
};

const USER_NAME = process.env.USER_NAME;

// Tracks how many GraphQL calls we make, printed at the end for visibility
// (rate limit is 5000 pts/hour, but it's nice to see the cost of a run).
const queryCount = {};
function bump(name) {
  queryCount[name] = (queryCount[name] || 0) + 1;
}

async function gql(name, query, variables) {
  bump(name);
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`${name} failed: ${res.status} ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

/** Basic identity: node id + account creation date (used for "coding since"). */
async function getUser(username) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        id
        createdAt
      }
    }`;
  const data = await gql('getUser', query, { login: username });
  return { id: data.user.id, createdAt: data.user.createdAt };
}

/** Total followers. */
async function getFollowers(username) {
  const query = `
    query($login: String!) {
      user(login: $login) {
        followers { totalCount }
      }
    }`;
  const data = await gql('getFollowers', query, { login: username });
  return data.user.followers.totalCount;
}

/**
 * Full contribution activity in a date range: commit/PR/issue totals plus the
 * day-by-day calendar (needed to compute streaks). Requires the token to have
 * "Pull requests" and "Issues" repository read permissions in addition to
 * "Contents"/"Metadata"/"Commit statuses" -- otherwise totalPullRequestContributions
 * and totalIssueContributions come back as 0 even though the query succeeds.
 */
async function getContributions(startDate, endDate) {
  const query = `
    query($start: DateTime!, $end: DateTime!, $login: String!) {
      user(login: $login) {
        contributionsCollection(from: $start, to: $end) {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }`;
  const data = await gql('getContributions', query, {
    start: startDate,
    end: endDate,
    login: USER_NAME,
  });
  const c = data.user.contributionsCollection;
  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  return {
    totalCommits: c.totalCommitContributions,
    totalContributions: c.contributionCalendar.totalContributions,
    totalPRs: c.totalPullRequestContributions,
    totalIssues: c.totalIssueContributions,
    days, // [{ date: 'YYYY-MM-DD', contributionCount: n }, ...] oldest first
  };
}

/**
 * Current and longest daily-contribution streaks from a calendar day list.
 * "Current" counts backward from the most recent day with any activity,
 * so a streak isn't wiped out just because today hasn't happened yet.
 */
function computeStreaks(days) {
  let longest = 0;
  let running = 0;
  for (const day of days) {
    if (day.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }

  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) {
      current += 1;
    } else if (i === days.length - 1) {
      continue; // today has no activity yet -- don't count it as a break
    } else {
      break;
    }
  }

  return { current, longest };
}

/**
 * Repos + star counts for given ownerAffiliations (paginated).
 * affiliations: array like ['OWNER'] or ['OWNER','COLLABORATOR','ORGANIZATION_MEMBER']
 */
async function getReposAndStars(affiliations, cursor = null, edges = []) {
  const query = `
    query($aff: [RepositoryAffiliation], $login: String!, $cursor: String) {
      user(login: $login) {
        repositories(first: 100, after: $cursor, ownerAffiliations: $aff) {
          totalCount
          edges {
            node {
              nameWithOwner
              stargazers { totalCount }
              primaryLanguage { name }
            }
          }
          pageInfo { endCursor hasNextPage }
        }
      }
    }`;
  const data = await gql('getReposAndStars', query, {
    aff: affiliations,
    login: USER_NAME,
    cursor,
  });
  const repos = data.user.repositories;
  edges = edges.concat(repos.edges);
  if (repos.pageInfo.hasNextPage) {
    return getReposAndStars(affiliations, repos.pageInfo.endCursor, edges);
  }
  const totalStars = edges.reduce((sum, e) => sum + e.node.stargazers.totalCount, 0);
  return { totalCount: repos.totalCount, totalStars, edges };
}

/** Repo list (with commit-history totalCount) for LOC caching — mirrors Andrew's loc_query. */
async function getReposForLoc(affiliations, cursor = null, edges = []) {
  const query = `
    query($aff: [RepositoryAffiliation], $login: String!, $cursor: String) {
      user(login: $login) {
        repositories(first: 60, after: $cursor, ownerAffiliations: $aff) {
          edges {
            node {
              nameWithOwner
              defaultBranchRef {
                target {
                  ... on Commit {
                    history { totalCount }
                  }
                }
              }
            }
          }
          pageInfo { endCursor hasNextPage }
        }
      }
    }`;
  const data = await gql('getReposForLoc', query, {
    aff: affiliations,
    login: USER_NAME,
    cursor,
  });
  const repos = data.user.repositories;
  edges = edges.concat(repos.edges);
  if (repos.pageInfo.hasNextPage) {
    return getReposForLoc(affiliations, repos.pageInfo.endCursor, edges);
  }
  return edges;
}

/**
 * Walks every commit of one repo's default branch (100 at a time) and sums
 * additions/deletions for commits authored by ownerId. Recursive like Andrew's version
 * because GraphQL only returns 100 commits per page.
 */
async function getRepoLoc(owner, repoName, ownerId, cursor = null, add = 0, del = 0, myCommits = 0) {
  const query = `
    query($repoName: String!, $owner: String!, $cursor: String) {
      repository(name: $repoName, owner: $owner) {
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 100, after: $cursor) {
                edges {
                  node {
                    author { user { id } }
                    additions
                    deletions
                  }
                }
                pageInfo { endCursor hasNextPage }
              }
            }
          }
        }
      }
    }`;
  bump('getRepoLoc');
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables: { repoName, owner, cursor } }),
  });
  const json = await res.json();
  const branch = json?.data?.repository?.defaultBranchRef;
  if (!branch) return { add, del, myCommits }; // empty repo

  const history = branch.target.history;
  for (const edge of history.edges) {
    if (edge.node.author.user && edge.node.author.user.id === ownerId) {
      myCommits += 1;
      add += edge.node.additions;
      del += edge.node.deletions;
    }
  }
  if (!history.pageInfo.hasNextPage) return { add, del, myCommits };
  return getRepoLoc(owner, repoName, ownerId, history.pageInfo.endCursor, add, del, myCommits);
}

module.exports = {
  getUser,
  getFollowers,
  getContributions,
  computeStreaks,
  getReposAndStars,
  getReposForLoc,
  getRepoLoc,
  queryCount,
  USER_NAME,
};
