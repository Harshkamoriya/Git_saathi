// Pure shaping for the analytics page. GitHub fetching lives in github-insights.ts.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const DAY_MS = 86_400_000;
const TOP_FILE_TYPES = 8;
const CODE_FREQUENCY_WEEKS = 52;
const DAILY_COMMIT_WEEKS = 12;

export interface ContributorRow {
  author: string;
  commits: number;
  linesAdded: number;
  linesDeleted: number;
  avatar?: string;
}

export interface DayCount {
  date: string;
  count: number;
}

export interface WeekdayCount {
  day: string;
  count: number;
}

export interface CodeWeek {
  weekStart: string;
  additions: number;
  deletions: number;
}

export interface LanguageShare {
  name: string;
  bytes: number;
  percentage: number;
}

export interface FileTypeShare {
  extension: string;
  count: number;
  percentage: number;
}

/** `per_page=1` makes the `rel="last"` page number the total count. */
export function countFromLink(linkHeader: string | undefined, pageLength: number): number {
  if (!linkHeader) return pageLength;
  const last = linkHeader.match(/[&?]page=(\d+)[^>]*>;\s*rel="last"/);
  return last ? Number(last[1]) : pageLength;
}

export function extensionOf(path: string): string {
  const base = path.split("/").pop() || path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return dot === 0 ? base.slice(1).toLowerCase() : "(none)";
  return base.slice(dot + 1).toLowerCase();
}

export function summarizeFileTypes(paths: string[]): FileTypeShare[] {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const extension = extensionOf(path);
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, TOP_FILE_TYPES);
  const rest = sorted.slice(TOP_FILE_TYPES).reduce((sum, [, count]) => sum + count, 0);
  const share = (count: number) => (total ? Math.round((count / total) * 1000) / 10 : 0);
  const rows = top.map(([extension, count]) => ({ extension, count, percentage: share(count) }));
  if (rest > 0) rows.push({ extension: "other", count: rest, percentage: share(rest) });
  return rows;
}

export function averageDays(spans: { start: string; end: string }[]): { average: number | null; sampleSize: number } {
  const valid = spans.filter((span) => {
    const start = new Date(span.start).getTime();
    const end = new Date(span.end).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && end >= start;
  });
  if (valid.length === 0) return { average: null, sampleSize: 0 };
  const total = valid.reduce((sum, span) => sum + (new Date(span.end).getTime() - new Date(span.start).getTime()) / DAY_MS, 0);
  return { average: Math.round((total / valid.length) * 10) / 10, sampleSize: valid.length };
}

export function shapeContributors(raw: unknown): { rows: ContributorRow[]; total: number } {
  if (!Array.isArray(raw)) return { rows: [], total: 0 };
  const merged = new Map<string, ContributorRow>();

  for (const entry of raw) {
    const row = entry as {
      author?: { login?: string | null; avatar_url?: string | null } | null;
      total?: number;
      weeks?: { a?: number; d?: number }[];
    };
    const author = row.author?.login || "Unknown";
    const lines = (row.weeks || []).reduce(
      (sum, week) => ({ added: sum.added + (week.a || 0), deleted: sum.deleted + (week.d || 0) }),
      { added: 0, deleted: 0 }
    );
    const key = author.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.commits += row.total || 0;
      existing.linesAdded += lines.added;
      existing.linesDeleted += lines.deleted;
      if (!existing.avatar && row.author?.avatar_url) existing.avatar = row.author.avatar_url;
    } else {
      merged.set(key, {
        author,
        commits: row.total || 0,
        linesAdded: lines.added,
        linesDeleted: lines.deleted,
        avatar: row.author?.avatar_url || undefined,
      });
    }
  }

  const rows = [...merged.values()].sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author));
  return { rows, total: rows.length };
}

/** Last year of commit activity. Daily series is the last 12 weeks; weekdays cover the full year. */
export function shapeActivity(raw: unknown, now = new Date()): { commitsPerDay: DayCount[]; commitFrequency: WeekdayCount[] } | null {
  if (!Array.isArray(raw)) return null;
  const weeks = raw as { days?: number[]; week?: number }[];
  const commitFrequency = WEEKDAYS.map((day, index) => ({
    day,
    count: weeks.reduce((sum, week) => sum + (week.days?.[index] || 0), 0),
  }));
  const today = now.toISOString().slice(0, 10);
  const commitsPerDay = weeks.slice(-DAILY_COMMIT_WEEKS).flatMap((week) => {
    if (!week.week) return [];
    return (week.days || []).map((count, index) => ({
      date: new Date(week.week! * 1000 + index * DAY_MS).toISOString().slice(0, 10),
      count: count || 0,
    }));
  }).filter((point) => point.date <= today);

  return { commitsPerDay, commitFrequency };
}

/** Weekly additions and deletions. GitHub reports deletions as negative numbers. */
export function shapeCodeFrequency(raw: unknown): CodeWeek[] | null {
  if (!Array.isArray(raw)) return null;
  return (raw as number[][]).slice(-CODE_FREQUENCY_WEEKS).flatMap((week) => {
    if (!week?.[0]) return [];
    return [{
      weekStart: new Date(week[0] * 1000).toISOString().slice(0, 10),
      additions: week[1] || 0,
      deletions: Math.abs(week[2] || 0),
    }];
  });
}

export type WorkKind = "pr" | "issue";
export type WorkState = "all" | "open" | "closed" | "merged";
export type WorkSort = "newest" | "oldest" | "updated";

export interface WorkItem {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  comments: number;
  labels: string[];
}

const WORK_STATES = new Set<WorkState>(["all", "open", "closed", "merged"]);
const WORK_SORTS = new Set<WorkSort>(["newest", "oldest", "updated"]);

export function normalizeWorkQuery(input: { kind?: string; state?: string; sort?: string; page?: number; text?: string }) {
  const kind: WorkKind = input.kind === "issue" ? "issue" : "pr";
  const requested = WORK_STATES.has(input.state as WorkState) ? (input.state as WorkState) : "all";
  const state: WorkState = kind === "issue" && requested === "merged" ? "closed" : requested;
  const sort: WorkSort = WORK_SORTS.has(input.sort as WorkSort) ? (input.sort as WorkSort) : "newest";
  const page = Number.isFinite(input.page) ? Math.min(50, Math.max(1, Math.floor(input.page!))) : 1;
  const text = (input.text || "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return { kind, state, sort, page, text };
}

/** Search stays inside this repo. User text is a quoted phrase, so it can't add extra qualifiers. */
export function workSearchQuery(owner: string, repo: string, kind: WorkKind, state: WorkState, text = "") {
  const qualifiers = [`repo:${owner}/${repo}`, kind === "issue" ? "is:issue" : "is:pr"];
  if (kind === "pr" && state === "merged") qualifiers.push("is:merged");
  else if (kind === "pr" && state === "closed") qualifiers.push("is:closed", "-is:merged");
  else if (state === "open" || state === "closed") qualifiers.push(`is:${state}`);
  const phrase = text.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return phrase ? `${qualifiers.join(" ")} "${phrase}"` : qualifiers.join(" ");
}

export function workSearchOrder(sort: WorkSort): { sort: "created" | "updated"; order: "asc" | "desc" } {
  if (sort === "oldest") return { sort: "created", order: "asc" };
  if (sort === "updated") return { sort: "updated", order: "desc" };
  return { sort: "created", order: "desc" };
}

export function shapeWorkItem(
  raw: {
    number: number;
    title: string;
    state?: string | null;
    html_url: string;
    draft?: boolean | null;
    comments?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    user?: { login?: string | null } | null;
    labels?: ({ name?: string | null } | string)[] | null;
    pull_request?: { merged_at?: string | null } | null;
  },
  preferMerged = false
): WorkItem {
  const merged = Boolean(raw.pull_request?.merged_at) || (preferMerged && Boolean(raw.pull_request));
  const state: WorkItem["state"] = merged ? "merged" : raw.state === "open" ? "open" : "closed";
  const labels = (raw.labels || []).flatMap((label) => {
    if (typeof label === "string") return label ? [label] : [];
    return label?.name ? [label.name] : [];
  });
  return {
    number: raw.number,
    title: raw.title,
    state,
    draft: Boolean(raw.draft),
    author: raw.user?.login || "Unknown",
    createdAt: raw.created_at || "",
    updatedAt: raw.updated_at || "",
    url: raw.html_url,
    comments: raw.comments || 0,
    labels,
  };
}

export function shapeLanguages(languages: Record<string, number> | null): LanguageShare[] {
  if (!languages) return [];
  const entries = Object.entries(languages).filter(([, bytes]) => bytes > 0);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  return entries
    .map(([name, bytes]) => ({
      name,
      bytes,
      percentage: total ? Math.round((bytes / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}
