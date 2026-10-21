"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ExternalLink, GitPullRequest, MessageSquare, RefreshCw, Tag, User } from "lucide-react";
import { getWorkItems, type WorkList } from "@/lib/github-insights";
import type { WorkSort, WorkState } from "@/lib/repoAnalytics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

function formatUpdated(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function count(value: number | null) {
  return value === null ? "—" : value.toLocaleString();
}

function stateClass(state: "open" | "closed" | "merged") {
  if (state === "open") return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-200 dark:border-green-900/50";
  if (state === "merged") return "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-900/50";
  return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600";
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-md border border-orange-200 p-4 dark:border-orange-900/50">
          <Skeleton className="mb-2 h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

const PRAndIssuesClient = ({ projectId }: { projectId: string }) => {
  const [kind, setKind] = useState<"pr" | "issue">("pr");
  const [prState, setPrState] = useState<WorkState>("all");
  const [issueState, setIssueState] = useState<WorkState>("all");
  const [prSort, setPrSort] = useState<WorkSort>("newest");
  const [issueSort, setIssueSort] = useState<WorkSort>("newest");
  const [prPage, setPrPage] = useState(1);
  const [issuePage, setIssuePage] = useState(1);
  const [draft, setDraft] = useState("");
  const [text, setText] = useState("");
  const [data, setData] = useState<WorkList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasData = useRef(false);
  const request = useRef(0);

  const state = kind === "pr" ? prState : issueState;
  const sort = kind === "pr" ? prSort : issueSort;
  const page = kind === "pr" ? prPage : issuePage;

  const setState = (value: WorkState) => {
    if (kind === "pr") setPrState(value);
    else setIssueState(value === "merged" ? "closed" : value);
    if (kind === "pr") setPrPage(1);
    else setIssuePage(1);
  };

  const setSort = (value: WorkSort) => {
    if (kind === "pr") {
      setPrSort(value);
      setPrPage(1);
    } else {
      setIssueSort(value);
      setIssuePage(1);
    }
  };

  const setPage = (value: number) => {
    if (kind === "pr") setPrPage(value);
    else setIssuePage(value);
  };

  const load = useCallback(
    async (refresh = false) => {
      const id = ++request.current;
      if (hasData.current) setRefreshing(true);
      else setLoading(true);
      const result = await getWorkItems(projectId, { kind, state, sort, page, text }, refresh);
      if (id !== request.current) return;
      if (!result.ok) setError(result.error);
      else {
        hasData.current = true;
        setData(result.data);
        setError(null);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [projectId, kind, state, sort, page, text]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const listReady =
    data !== null && data.kind === kind && data.state === state && data.sort === sort && data.page === page && data.text === text;

  if (loading && !data) {
    return (
      <div className="p-2">
        <Skeleton className="mb-2 h-8 w-48" />
        <Skeleton className="mb-6 h-4 w-80" />
        <ListSkeleton />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="px-2 py-16 text-center">
        <p className="text-gray-700 dark:text-gray-200">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => load(true)}>
          Try again
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const pages = Math.max(1, Math.ceil(Math.min(listReady ? data.total : 0, 1000) / data.perPage));
  const start = !listReady || data.total === 0 ? 0 : (data.page - 1) * data.perPage + 1;
  const end = listReady ? Math.min(data.page * data.perPage, data.total) : 0;
  const noun = kind === "pr" ? "pull requests" : "issues";

  return (
    <div className="p-2 text-gray-800 dark:text-gray-100">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-orange-500 to-pink-500">
            {data.name}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            {count(data.openIssues)} open issues · {count(data.openPullRequests)} open pull requests
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {data.averageIssueResolutionTime === null
              ? "No closed-issue sample yet"
              : `Issue close time ${data.averageIssueResolutionTime} days, from ${data.issueSampleSize} recent`}
            {" · "}
            {data.averagePrCycleTime === null
              ? "No merged pull-request sample yet"
              : `PR cycle ${data.averagePrCycleTime} days, from ${data.prSampleSize} recent merged`}
          </p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Updated {formatUpdated(data.fetchedAt)}
            {" · "}
            <a href={data.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              View on GitHub <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing || loading}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {error ? <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}

      <div className="mb-4 flex border-b border-orange-200 dark:border-orange-900/50">
        <button
          type="button"
          onClick={() => setKind("pr")}
          className={`px-4 py-2 text-sm font-medium ${kind === "pr" ? "border-b-2 border-orange-500 text-orange-500" : "text-gray-600 hover:text-orange-500 dark:text-gray-300"}`}
        >
          <GitPullRequest className="mr-2 inline size-4" />
          Pull requests
        </button>
        <button
          type="button"
          onClick={() => setKind("issue")}
          className={`px-4 py-2 text-sm font-medium ${kind === "issue" ? "border-b-2 border-orange-500 text-orange-500" : "text-gray-600 hover:text-orange-500 dark:text-gray-300"}`}
        >
          <AlertCircle className="mr-2 inline size-4" />
          Issues
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={state} onValueChange={(value) => setState(value as WorkState)}>
          <SelectTrigger className="w-[150px] border-orange-200 bg-orange-50 text-orange-500 dark:border-orange-900/50 dark:bg-orange-900/20 dark:text-orange-400">
            <SelectValue placeholder="State" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            {kind === "pr" ? <SelectItem value="merged">Merged</SelectItem> : null}
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => setSort(value as WorkSort)}>
          <SelectTrigger className="w-[180px] border-orange-200 bg-orange-50 text-orange-500 dark:border-orange-900/50 dark:bg-orange-900/20 dark:text-orange-400">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
            <SelectItem value="updated">Recently updated</SelectItem>
          </SelectContent>
        </Select>
        <form
          className="flex min-w-[220px] flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setText(draft.trim());
            setPrPage(1);
            setIssuePage(1);
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search titles and text"
            aria-label="Search pull requests and issues"
          />
          <Button type="submit" variant="outline" size="sm">
            Search
          </Button>
          {text ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft("");
                setText("");
                setPrPage(1);
                setIssuePage(1);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>
      </div>

      {kind === "pr" && state === "closed" ? (
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">Closed means closed without being merged.</p>
      ) : null}

      {!listReady ? (
        <ListSkeleton />
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
            {data.total === 0 ? `No ${noun} found.` : `${start}–${end} of ${data.total.toLocaleString()} ${noun}`}
            {data.incomplete ? " · GitHub marked this search as partial. Refresh to try again." : ""}
          </p>
          {data.items.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">Nothing matches this filter.</div>
          ) : (
            <div className="space-y-3">
              {data.items.map((item) => (
                <a
                  key={item.number}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-md border border-orange-200 p-4 transition-colors hover:border-orange-400 dark:border-orange-900/50 dark:hover:border-orange-700"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium text-orange-600 dark:text-orange-400">
                      #{item.number} {item.title}
                    </p>
                    <Badge variant="outline" className={stateClass(item.state)}>
                      {item.draft ? "Draft" : item.state}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                    <User className="mr-1 inline size-4" />
                    {item.author}
                    {item.createdAt ? ` · opened ${new Date(item.createdAt).toLocaleDateString()}` : ""}
                    {item.updatedAt ? ` · updated ${new Date(item.updatedAt).toLocaleDateString()}` : ""}
                    {" · "}
                    <MessageSquare className="mr-1 inline size-4" />
                    {item.comments.toLocaleString()}
                  </p>
                  {item.labels.length > 0 ? (
                    <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                      <Tag className="size-3" />
                      {item.labels.slice(0, 4).map((label) => (
                        <span key={label} className="rounded-full border border-gray-200 px-2 py-0.5 dark:border-gray-600">
                          {label}
                        </span>
                      ))}
                      {item.labels.length > 4 ? <span>+{item.labels.length - 4}</span> : null}
                    </p>
                  ) : null}
                </a>
              ))}
            </div>
          )}

          {data.total > data.perPage ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button variant="outline" size="sm" disabled={page <= 1 || refreshing} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <p className="text-sm text-gray-500">
                Page {page} of {pages}
              </p>
              <Button variant="outline" size="sm" disabled={page >= pages || refreshing} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

export default PRAndIssuesClient;
