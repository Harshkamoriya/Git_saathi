"use server";

import { Octokit } from "octokit";
import { prisma } from "./db";
import { getAuthSession } from "./auth";
import { parseGithubUrl } from "./repoRules";
import {
  averageDays,
  countFromLink,
  normalizeWorkQuery,
  shapeActivity,
  shapeCodeFrequency,
  shapeContributors,
  shapeLanguages,
  shapeWorkItem,
  summarizeFileTypes,
  workSearchOrder,
  workSearchQuery,
  type CodeWeek,
  type ContributorRow,
  type DayCount,
  type FileTypeShare,
  type LanguageShare,
  type WeekdayCount,
  type WorkItem,
  type WorkKind,
  type WorkSort,
  type WorkState,
} from "./repoAnalytics";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const CACHE_TTL_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 20_000;
const MAX_CACHE_ENTRIES = 50;
const FETCH_TIMEOUT_MS = 30_000;
const STATS_ATTEMPTS = 3;
const SHOWN_CONTRIBUTORS = 24;

export interface RepoAnalytics {
  name: string;
  description: string;
  htmlUrl: string;
  defaultBranch: string;
  fetchedAt: string;
  totalCommits: number;
  totalContributors: number;
  contributors: ContributorRow[];
  openIssues: number | null;
  openPullRequests: number;
  branchCount: number;
  stargazers: number;
  forks: number;
  languages: LanguageShare[];
  fileTypes: FileTypeShare[];
  fileTypesTruncated: boolean;
  commitsPerDay: DayCount[];
  commitFrequency: WeekdayCount[];
  codeFrequency: CodeWeek[];
  recentCommits: {
    message: string;
    author: string;
    date: string;
    sha: string;
    url: string;
    additions: number;
    deletions: number;
    filesChanged: number;
  }[];
  averageIssueResolutionTime: number | null;
  issueSampleSize: number;
  averagePrCycleTime: number | null;
  prSampleSize: number;
  statsPending: boolean;
}

export type AnalyticsResult = { ok: true; data: RepoAnalytics } | { ok: false; error: string };

const insightsCache = new Map<string, { at: number; ttl: number; data: RepoAnalytics }>();
const inflight = new Map<string, Promise<RepoAnalytics>>();
const WORK_CACHE_TTL_MS = 5 * 60 * 1000;
const SUMMARY_TTL_MS = 10 * 60 * 1000;
const WORK_PER_PAGE = 20;
const workCache = new Map<string, { at: number; data: WorkList }>();
const summaryCache = new Map<string, { at: number; data: WorkSummary }>();
const workInflight = new Map<string, Promise<WorkList>>();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function remember(projectId: string, data: RepoAnalytics) {
  if (insightsCache.size >= MAX_CACHE_ENTRIES) insightsCache.delete(insightsCache.keys().next().value!);
  insightsCache.set(projectId, {
    at: Date.now(),
    ttl: data.statsPending ? PENDING_TTL_MS : CACHE_TTL_MS,
    data,
  });
}

function readCache(projectId: string) {
  const hit = insightsCache.get(projectId);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    insightsCache.delete(projectId);
    return null;
  }
  return hit.data;
}

function linkHeader(headers: object) {
  const link = (headers as { link?: string }).link;
  return typeof link === "string" ? link : undefined;
}

function analyticsErrorMessage(error: unknown) {
  if (error instanceof Error && error.message === "timeout") {
    return "GitHub is taking too long. Please try again.";
  }
  const status = (error as { status?: number })?.status;
  if (status === 404) return "Repository not found, or the server's GitHub token can't see it.";
  if (status === 403 || status === 429) return "GitHub rate limit reached. Please wait a few minutes and try again.";
  if (status === 401) return "The server's GitHub token is invalid.";
  return "Couldn't load analytics right now. Please try again.";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** GitHub stats endpoints answer 202 while they compute, then 200. */
async function readStats(request: () => Promise<{ status: number; data?: unknown }>) {
  for (let attempt = 0; attempt < STATS_ATTEMPTS; attempt++) {
    const response = await request();
    if (response.status === 200) return { data: response.data ?? null, pending: false };
    if (response.status !== 202 || attempt === STATS_ATTEMPTS - 1) {
      return { data: null, pending: response.status === 202 };
    }
    await delay(1500);
  }
  return { data: null, pending: true };
}

async function quietly<T>(label: string, fallback: T, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    console.error(`github ${label} failed:`, (error as Error).message);
    return fallback;
  }
}

async function commitCount(owner: string, repo: string) {
  try {
    const response = await octokit.rest.repos.listCommits({ owner, repo, per_page: 1 });
    return countFromLink(linkHeader(response.headers), response.data.length);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) return 0;
    throw error;
  }
}

async function branchCount(owner: string, repo: string) {
  const response = await octokit.rest.repos.listBranches({ owner, repo, per_page: 1 });
  return countFromLink(linkHeader(response.headers), response.data.length);
}

async function openIssueCount(owner: string, repo: string) {
  const { data } = await octokit.request("GET /search/issues", {
    q: `repo:${owner}/${repo} is:issue is:open`,
    per_page: 1,
  });
  return data.total_count;
}

async function openPullCount(owner: string, repo: string) {
  const response = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 1 });
  return countFromLink(linkHeader(response.headers), response.data.length);
}

async function issueResolution(owner: string, repo: string) {
  const { data } = await octokit.rest.issues.listForRepo({ owner, repo, state: "closed", per_page: 100 });
  return averageDays(
    data
      .filter((issue) => !issue.pull_request && issue.closed_at)
      .map((issue) => ({ start: issue.created_at, end: issue.closed_at! }))
  );
}

async function prCycle(owner: string, repo: string) {
  const { data } = await octokit.rest.pulls.list({ owner, repo, state: "closed", per_page: 100 });
  return averageDays(
    data.filter((pr) => pr.merged_at).map((pr) => ({ start: pr.created_at, end: pr.merged_at! }))
  );
}

async function recentCommits(owner: string, repo: string) {
  try {
    const { data } = await octokit.rest.repos.listCommits({ owner, repo, per_page: 5 });
    const detailed = await Promise.all(
      data.map(async (commit) => {
        let additions = 0;
        let deletions = 0;
        let filesChanged = 0;
        try {
          const full = await octokit.rest.repos.getCommit({ owner, repo, ref: commit.sha });
          additions = full.data.stats?.additions ?? 0;
          deletions = full.data.stats?.deletions ?? 0;
          filesChanged = full.data.files?.length ?? 0;
        } catch (error) {
          console.error("analytics commit detail failed:", (error as Error).message);
        }
        return {
          message: (commit.commit.message.split("\n")[0] || "No message").slice(0, 140),
          author: commit.author?.login || commit.commit.author?.name || "Unknown",
          date: commit.commit.author?.date || commit.commit.committer?.date || new Date().toISOString(),
          sha: commit.sha,
          url: commit.html_url,
          additions,
          deletions,
          filesChanged,
        };
      })
    );
    return detailed;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) return [];
    throw error;
  }
}

async function fileTypes(owner: string, repo: string, branch: string) {
  const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: branch, recursive: "true" });
  const paths = data.tree.flatMap((item) => (item.type === "blob" && item.path ? [item.path] : []));
  return { fileTypes: summarizeFileTypes(paths), fileTypesTruncated: Boolean(data.truncated) };
}

async function buildAnalytics(projectId: string, owner: string, repo: string): Promise<RepoAnalytics> {
  const started = Date.now();
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });

  const [
    totalCommits,
    branches,
    languages,
    contributorStats,
    activityStats,
    codeStats,
    openIssues,
    openPullRequests,
    issues,
    pulls,
    commits,
    files,
  ] = await Promise.all([
    quietly("commits", 0, () => commitCount(owner, repo)),
    quietly("branches", 0, () => branchCount(owner, repo)),
    quietly("languages", [] as LanguageShare[], async () => {
      const { data } = await octokit.rest.repos.listLanguages({ owner, repo });
      return shapeLanguages(data);
    }),
    quietly("contributors", { rows: [] as ContributorRow[], total: 0, pending: false }, async () => {
      const stats = await readStats(() => octokit.rest.repos.getContributorsStats({ owner, repo }));
      const shaped = shapeContributors(stats.data);
      return { rows: shaped.rows.slice(0, SHOWN_CONTRIBUTORS), total: shaped.total, pending: stats.pending };
    }),
    quietly("activity", { series: null as ReturnType<typeof shapeActivity>, pending: false }, async () => {
      const stats = await readStats(() => octokit.rest.repos.getCommitActivityStats({ owner, repo }));
      return { series: stats.pending ? null : shapeActivity(stats.data), pending: stats.pending };
    }),
    quietly("code frequency", { series: null as ReturnType<typeof shapeCodeFrequency>, pending: false }, async () => {
      const stats = await readStats(() => octokit.rest.repos.getCodeFrequencyStats({ owner, repo }));
      return { series: stats.pending ? null : shapeCodeFrequency(stats.data), pending: stats.pending };
    }),
    quietly("open issues", null as number | null, () => openIssueCount(owner, repo)),
    quietly("open pulls", 0, () => openPullCount(owner, repo)),
    quietly("issue time", { average: null, sampleSize: 0 }, () => issueResolution(owner, repo)),
    quietly("pr cycle", { average: null, sampleSize: 0 }, () => prCycle(owner, repo)),
    quietly("recent commits", [], () => recentCommits(owner, repo)),
    quietly("files", { fileTypes: [] as FileTypeShare[], fileTypesTruncated: false }, () =>
      fileTypes(owner, repo, repoData.default_branch)
    ),
  ]);

  const statsPending = contributorStats.pending || activityStats.pending || codeStats.pending;
  const data: RepoAnalytics = {
    name: repoData.name,
    description: repoData.description || "No description",
    htmlUrl: repoData.html_url,
    defaultBranch: repoData.default_branch,
    fetchedAt: new Date().toISOString(),
    totalCommits,
    totalContributors: contributorStats.total,
    contributors: contributorStats.rows,
    openIssues,
    openPullRequests,
    branchCount: branches,
    stargazers: repoData.stargazers_count,
    forks: repoData.forks_count,
    languages,
    fileTypes: files.fileTypes,
    fileTypesTruncated: files.fileTypesTruncated,
    commitsPerDay: activityStats.series?.commitsPerDay ?? [],
    commitFrequency: activityStats.series?.commitFrequency ?? [],
    codeFrequency: codeStats.series ?? [],
    recentCommits: commits,
    averageIssueResolutionTime: issues.average,
    issueSampleSize: issues.sampleSize,
    averagePrCycleTime: pulls.average,
    prSampleSize: pulls.sampleSize,
    statsPending,
  };

  remember(projectId, data);
  console.log(`analytics ${owner}/${repo} ${Date.now() - started}ms pending=${statsPending}`);
  return data;
}

export async function getRepoStatus(projectId: string, refresh = false): Promise<AnalyticsResult> {
  try {
    const access = await requireProjectRepo(projectId, "analytics");
    if (!access.ok) return access;

    if (!refresh) {
      const cached = readCache(projectId);
      if (cached) return { ok: true, data: cached };
      const pending = inflight.get(projectId);
      if (pending) return { ok: true, data: await pending };
    }

    const work = buildAnalytics(projectId, access.owner, access.repo);
    void work.catch(() => undefined);
    inflight.set(projectId, work);
    try {
      return { ok: true, data: await withTimeout(work, FETCH_TIMEOUT_MS) };
    } finally {
      if (inflight.get(projectId) === work) inflight.delete(projectId);
    }
  } catch (error) {
    console.error("analytics failed", projectId, error);
    return { ok: false, error: analyticsErrorMessage(error) };
  }
}

interface WorkSummary {
  openIssues: number | null;
  openPullRequests: number | null;
  averageIssueResolutionTime: number | null;
  issueSampleSize: number;
  averagePrCycleTime: number | null;
  prSampleSize: number;
}

export interface WorkList extends WorkSummary {
  name: string;
  htmlUrl: string;
  kind: WorkKind;
  state: WorkState;
  sort: WorkSort;
  text: string;
  page: number;
  perPage: number;
  total: number;
  incomplete: boolean;
  items: WorkItem[];
  fetchedAt: string;
}

export type WorkListResult = { ok: true; data: WorkList } | { ok: false; error: string };

async function requireProjectRepo(projectId: string, feature: string) {
  const session = await getAuthSession();
  if (!session?.user?.id) return { ok: false as const, error: `Sign in to view ${feature}.` };

  const membership = await prisma.userToProject.findFirst({
    where: { userId: session.user.id, projectId, project: { deletedAt: null } },
    select: { project: { select: { githubUrl: true } } },
  });
  if (!membership) return { ok: false as const, error: "You don't have access to this project." };
  if (!membership.project.githubUrl) return { ok: false as const, error: "This project has no GitHub repository." };

  const repo = parseGithubUrl(membership.project.githubUrl);
  if (!repo) return { ok: false as const, error: "This project's GitHub URL is invalid." };
  return { ok: true as const, ...repo };
}

function rememberWork(key: string, data: WorkList) {
  if (workCache.size >= 100) workCache.delete(workCache.keys().next().value!);
  workCache.set(key, { at: Date.now(), data });
}

async function loadWorkSummary(owner: string, repo: string, refresh: boolean): Promise<WorkSummary> {
  const key = `${owner}/${repo}`;
  const hit = summaryCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.data;

  const [openIssues, openPullRequests, issues, pulls] = await Promise.all([
    quietly("open issues", null as number | null, () => openIssueCount(owner, repo)),
    quietly("open pulls", null as number | null, () => openPullCount(owner, repo)),
    quietly("issue time", { average: null, sampleSize: 0 }, () => issueResolution(owner, repo)),
    quietly("pr cycle", { average: null, sampleSize: 0 }, () => prCycle(owner, repo)),
  ]);
  const data: WorkSummary = {
    openIssues,
    openPullRequests,
    averageIssueResolutionTime: issues.average,
    issueSampleSize: issues.sampleSize,
    averagePrCycleTime: pulls.average,
    prSampleSize: pulls.sampleSize,
  };
  if (summaryCache.size >= 50) summaryCache.delete(summaryCache.keys().next().value!);
  summaryCache.set(key, { at: Date.now(), data });
  return data;
}

async function buildWorkList(
  owner: string,
  repo: string,
  url: string,
  query: ReturnType<typeof normalizeWorkQuery>,
  refresh: boolean
): Promise<WorkList> {
  const order = workSearchOrder(query.sort);
  const [summary, search] = await Promise.all([
    loadWorkSummary(owner, repo, refresh),
    octokit.request("GET /search/issues", {
      q: workSearchQuery(owner, repo, query.kind, query.state, query.text),
      sort: order.sort,
      order: order.order,
      per_page: WORK_PER_PAGE,
      page: query.page,
    }),
  ]);
  return {
    ...summary,
    name: `${owner}/${repo}`,
    htmlUrl: url,
    kind: query.kind,
    state: query.state,
    sort: query.sort,
    text: query.text,
    page: query.page,
    perPage: WORK_PER_PAGE,
    total: search.data.total_count,
    incomplete: Boolean(search.data.incomplete_results),
    items: search.data.items.map((item) => shapeWorkItem(item, query.state === "merged")),
    fetchedAt: new Date().toISOString(),
  };
}

export async function getWorkItems(
  projectId: string,
  input: { kind?: WorkKind; state?: WorkState; sort?: WorkSort; page?: number; text?: string } = {},
  refresh = false
): Promise<WorkListResult> {
  try {
    const access = await requireProjectRepo(projectId, "pull requests and issues");
    if (!access.ok) return access;

    const query = normalizeWorkQuery(input);
    const key = `${projectId}:${query.kind}:${query.state}:${query.sort}:${query.page}:${query.text.toLowerCase()}`;
    if (!refresh) {
      const cached = workCache.get(key);
      if (cached && Date.now() - cached.at < WORK_CACHE_TTL_MS) return { ok: true, data: cached.data };
      const pending = workInflight.get(key);
      if (pending) return { ok: true, data: await pending };
    }

    const started = Date.now();
    const work = buildWorkList(access.owner, access.repo, access.url, query, refresh);
    void work.catch(() => undefined);
    workInflight.set(key, work);
    try {
      const data = await withTimeout(work, FETCH_TIMEOUT_MS);
      rememberWork(key, data);
      console.log(`work items ${access.owner}/${access.repo} ${query.kind} ${query.state} p${query.page} ${Date.now() - started}ms`);
      return { ok: true, data };
    } finally {
      if (workInflight.get(key) === work) workInflight.delete(key);
    }
  } catch (error) {
    console.error("work items failed", projectId, error);
    const status = (error as { status?: number }).status;
    if (status === 422) return { ok: false, error: "GitHub couldn't run that search. Try a different phrase." };
    return { ok: false, error: analyticsErrorMessage(error) };
  }
}
