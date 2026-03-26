import { Octokit } from "@octokit/rest";
import { config } from "./config.js";

const octokit = new Octokit({
  auth: config.github.token || undefined,
  userAgent: "founder-bot/1.0",
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RepoActivity {
  repo: string;          // "owner/name"
  commits: Commit[];
  openPRs: PullRequest[];
  mergedPRs: PullRequest[];
  openIssues: Issue[];
}

export interface Commit {
  sha: string;
  message: string;       // first line only
  author: string;
  url: string;
  date: string;
}

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  createdAt: string;
  mergedAt?: string;
  draft: boolean;
  labels: string[];
}

export interface Issue {
  number: number;
  title: string;
  author: string;
  url: string;
  createdAt: string;
  labels: string[];
}

// ── Main fetcher ──────────────────────────────────────────────────────────────

/** Fetch activity for all configured repos for the past `sinceHours` hours. */
export async function getAllRepoActivity(sinceHours = 24): Promise<RepoActivity[]> {
  if (config.github.repos.length === 0) return [];

  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  const results = await Promise.allSettled(
    config.github.repos.map(({ owner, repo }) =>
      getRepoActivity(owner, repo, since)
    )
  );

  return results
    .filter((r): r is PromiseFulfilledResult<RepoActivity> => r.status === "fulfilled")
    .map((r) => r.value);
}

async function getRepoActivity(
  owner: string,
  repo: string,
  since: string
): Promise<RepoActivity> {
  const repoSlug = `${owner}/${repo}`;

  const [commits, openPRs, mergedPRs, openIssues] = await Promise.allSettled([
    fetchRecentCommits(owner, repo, since),
    fetchOpenPRs(owner, repo),
    fetchMergedPRs(owner, repo, since),
    fetchOpenIssues(owner, repo),
  ]);

  return {
    repo: repoSlug,
    commits:    commits.status    === "fulfilled" ? commits.value    : [],
    openPRs:    openPRs.status    === "fulfilled" ? openPRs.value    : [],
    mergedPRs:  mergedPRs.status  === "fulfilled" ? mergedPRs.value  : [],
    openIssues: openIssues.status === "fulfilled" ? openIssues.value : [],
  };
}

// ── Per-resource fetchers ─────────────────────────────────────────────────────

async function fetchRecentCommits(owner: string, repo: string, since: string): Promise<Commit[]> {
  const { data } = await octokit.repos.listCommits({
    owner,
    repo,
    since,
    per_page: 20,
  });

  return data.map((c) => ({
    sha: c.sha.slice(0, 7),
    message: (c.commit.message ?? "").split("\n")[0],
    author: c.commit.author?.name ?? c.author?.login ?? "unknown",
    url: c.html_url,
    date: c.commit.author?.date ?? "",
  }));
}

async function fetchOpenPRs(owner: string, repo: string): Promise<PullRequest[]> {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 20,
    sort: "updated",
    direction: "desc",
  });

  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login ?? "unknown",
    url: pr.html_url,
    createdAt: pr.created_at,
    draft: pr.draft ?? false,
    labels: pr.labels.map((l) => l.name ?? "").filter(Boolean),
  }));
}

async function fetchMergedPRs(owner: string, repo: string, since: string): Promise<PullRequest[]> {
  const { data } = await octokit.pulls.list({
    owner,
    repo,
    state: "closed",
    per_page: 20,
    sort: "updated",
    direction: "desc",
  });

  const sinceDate = new Date(since);
  return data
    .filter((pr) => pr.merged_at && new Date(pr.merged_at) >= sinceDate)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      url: pr.html_url,
      createdAt: pr.created_at,
      mergedAt: pr.merged_at ?? undefined,
      draft: pr.draft ?? false,
      labels: pr.labels.map((l) => l.name ?? "").filter(Boolean),
    }));
}

async function fetchOpenIssues(owner: string, repo: string): Promise<Issue[]> {
  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: "open",
    per_page: 20,
    sort: "updated",
    direction: "desc",
  });

  // GitHub returns PRs in the issues endpoint too — filter them out
  return data
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      author: issue.user?.login ?? "unknown",
      url: issue.html_url,
      createdAt: issue.created_at,
      labels: issue.labels
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter(Boolean),
    }));
}

// ── Formatter ─────────────────────────────────────────────────────────────────

/** Render activity into a compact Markdown block for Telegram or Claude context. */
export function formatActivityForTelegram(activities: RepoActivity[]): string {
  if (activities.length === 0) return "_No GitHub repos configured._";

  return activities
    .map((a) => {
      const lines: string[] = [`*${a.repo}*`];

      if (a.commits.length > 0) {
        lines.push(`  📦 ${a.commits.length} commit(s) in last 24h`);
        a.commits.slice(0, 3).forEach((c) => {
          lines.push(`    • \`${c.sha}\` ${c.message} — ${c.author}`);
        });
        if (a.commits.length > 3) lines.push(`    … and ${a.commits.length - 3} more`);
      } else {
        lines.push("  📦 No commits in last 24h");
      }

      if (a.mergedPRs.length > 0) {
        lines.push(`  ✅ ${a.mergedPRs.length} PR(s) merged`);
        a.mergedPRs.forEach((pr) => lines.push(`    • #${pr.number} ${pr.title}`));
      }

      if (a.openPRs.length > 0) {
        const ready = a.openPRs.filter((pr) => !pr.draft);
        const draft = a.openPRs.filter((pr) => pr.draft);
        if (ready.length) lines.push(`  🔁 ${ready.length} open PR(s) awaiting review`);
        if (draft.length) lines.push(`  🚧 ${draft.length} draft PR(s)`);
        a.openPRs.slice(0, 3).forEach((pr) =>
          lines.push(`    • #${pr.number} ${pr.title}${pr.draft ? " [draft]" : ""}`)
        );
      } else {
        lines.push("  🔁 No open PRs");
      }

      if (a.openIssues.length > 0) {
        lines.push(`  🐛 ${a.openIssues.length} open issue(s)`);
        a.openIssues.slice(0, 3).forEach((i) => lines.push(`    • #${i.number} ${i.title}`));
        if (a.openIssues.length > 3) lines.push(`    … and ${a.openIssues.length - 3} more`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

/** Compact plaintext summary for injecting into Claude context. */
export function formatActivityForClaude(activities: RepoActivity[]): string {
  if (activities.length === 0) return "";

  return activities
    .map((a) => {
      const parts: string[] = [`Repo: ${a.repo}`];
      parts.push(`  Commits (24h): ${a.commits.length}`);
      if (a.commits.length > 0) {
        a.commits.slice(0, 5).forEach((c) => parts.push(`    - [${c.sha}] ${c.message} by ${c.author}`));
      }
      parts.push(`  Open PRs: ${a.openPRs.length}`);
      a.openPRs.slice(0, 5).forEach((pr) =>
        parts.push(`    - #${pr.number} "${pr.title}" by ${pr.author}${pr.draft ? " [DRAFT]" : ""}`)
      );
      parts.push(`  Merged PRs (24h): ${a.mergedPRs.length}`);
      a.mergedPRs.slice(0, 5).forEach((pr) =>
        parts.push(`    - #${pr.number} "${pr.title}" by ${pr.author}`)
      );
      parts.push(`  Open issues: ${a.openIssues.length}`);
      a.openIssues.slice(0, 5).forEach((i) =>
        parts.push(`    - #${i.number} "${i.title}" by ${i.author}`)
      );
      return parts.join("\n");
    })
    .join("\n\n");
}
