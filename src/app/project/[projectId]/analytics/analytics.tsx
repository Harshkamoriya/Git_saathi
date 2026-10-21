"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ExternalLink, File, FileCode, RefreshCw } from "lucide-react";
import { SiCss3, SiHtml5, SiJavascript, SiJson, SiMarkdown, SiPython, SiTypescript, SiYaml } from "react-icons/si";
import { getRepoStatus, type RepoAnalytics } from "@/lib/github-insights";
import { Button } from "@/components/ui/button";
import Loading from "./loading";

const tooltipStyle = {
  backgroundColor: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--foreground)",
};

const axisTick = { fill: "currentColor", fontSize: 12 };

function formatUpdated(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLabel(value: number | null) {
  return value === null ? "—" : value.toLocaleString();
}

function shortDate(value: string) {
  return value.slice(5);
}

const languageIcons: Record<string, React.ReactNode> = {
  JavaScript: <SiJavascript className="text-yellow-500" />,
  TypeScript: <SiTypescript className="text-blue-600" />,
  Python: <SiPython className="text-blue-400" />,
  HTML: <SiHtml5 className="text-orange-500" />,
  CSS: <SiCss3 className="text-blue-500" />,
  JSON: <SiJson className="text-gray-500" />,
  Markdown: <SiMarkdown className="text-gray-700 dark:text-gray-300" />,
  YAML: <SiYaml className="text-red-500" />,
};

function fileTypeIcon(extension: string) {
  switch (extension.toLowerCase()) {
    case "js":
    case "jsx":
      return <SiJavascript className="text-yellow-500" />;
    case "ts":
    case "tsx":
      return <SiTypescript className="text-blue-600" />;
    case "py":
      return <SiPython className="text-blue-400" />;
    case "html":
      return <SiHtml5 className="text-orange-500" />;
    case "css":
      return <SiCss3 className="text-blue-500" />;
    case "json":
      return <SiJson className="text-gray-500" />;
    case "md":
      return <SiMarkdown className="text-gray-700 dark:text-gray-300" />;
    case "yaml":
    case "yml":
      return <SiYaml className="text-red-500" />;
    default:
      return <File className="text-gray-500" />;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      {hint ? <p className="mb-3 mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

function EmptyChart({ pending, label }: { pending: boolean; label: string }) {
  return (
    <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-gray-300 px-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:text-gray-400">
      {pending ? "GitHub is still computing this chart. It will refresh shortly." : label}
    </div>
  );
}

function ChartFrame({ children }: { children: React.ReactElement }) {
  return (
    <div className="h-[300px] w-full text-gray-500 dark:text-gray-400">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const RepoInsights = ({ projectId }: { projectId: string }) => {
  const [data, setData] = useState<RepoAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasData = useRef(false);
  const retried = useRef(false);

  const load = useCallback(
    async (refresh = false, automatic = false) => {
      if (refresh && !automatic) retried.current = false;
      if (hasData.current) setRefreshing(true);
      else setLoading(true);

      const result = await getRepoStatus(projectId, refresh);
      if (!result.ok) {
        setError(result.error);
      } else {
        hasData.current = true;
        setData(result.data);
        setError(null);
      }
      setLoading(false);
      setRefreshing(false);
    },
    [projectId]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  useEffect(() => {
    if (!data?.statsPending || retried.current) return;
    retried.current = true;
    const timer = setTimeout(() => load(true, true), 4000);
    return () => clearTimeout(timer);
  }, [data?.statsPending, data?.fetchedAt, load]);

  if (loading && !data) return <Loading />;

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

  const contributorCount = data.statsPending && data.contributors.length === 0 ? "…" : data.totalContributors.toLocaleString();

  return (
    <div className="p-2 text-gray-800 dark:text-gray-100">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">{data.name}</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{data.description}</p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Branch {data.defaultBranch} · updated {formatUpdated(data.fetchedAt)}
            {" · "}
            <a href={data.htmlUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
              View on GitHub <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          Refresh
        </Button>
      </div>

      {error ? <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      {data.statsPending ? (
        <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">
          GitHub is still computing some statistics. This page will try once more in a few seconds.
        </p>
      ) : null}

      <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Commits" value={data.totalCommits.toLocaleString()} />
        <Stat label="Contributors" value={contributorCount} />
        <Stat label="Open issues" value={countLabel(data.openIssues)} />
        <Stat label="Open pull requests" value={data.openPullRequests.toLocaleString()} />
        <Stat label="Branches" value={data.branchCount.toLocaleString()} />
        <Stat label="Stars" value={data.stargazers.toLocaleString()} />
        <Stat label="Forks" value={data.forks.toLocaleString()} />
      </div>

      <Section
        title="Contributors"
        hint="Grouped by GitHub login, on the default branch. Additions and deletions come from GitHub's contributor stats."
      >
        {data.contributors.length === 0 ? (
          <EmptyChart pending={data.statsPending} label="No contributor stats for this repository." />
        ) : (
          <>
            {data.totalContributors > data.contributors.length ? (
              <p className="mb-3 text-xs text-gray-500">
                Showing the top {data.contributors.length} of {data.totalContributors}.
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {data.contributors.map((contributor) => (
                <div
                  key={contributor.author}
                  className="flex items-center rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                >
                  {contributor.avatar ? (
                    <img
                      src={contributor.avatar}
                      alt=""
                      className="mr-3 size-10 rounded-full"
                      referrerPolicy="no-referrer"
                    />
                  ) : null}
                  <div>
                    <p className="font-medium">{contributor.author}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {contributor.commits.toLocaleString()} commits · +{contributor.linesAdded.toLocaleString()} · −
                      {contributor.linesDeleted.toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title="Commits per day" hint="Last 12 weeks, default branch.">
        {data.commitsPerDay.length === 0 ? (
          <EmptyChart pending={data.statsPending} label="No commits in the last 12 weeks." />
        ) : (
          <ChartFrame>
            <LineChart data={data.commitsPerDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.25} />
              <XAxis dataKey="date" tick={axisTick} tickFormatter={shortDate} interval={6} />
              <YAxis tick={axisTick} allowDecimals={false} width={32} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Line type="monotone" dataKey="count" stroke="#8884d8" name="Commits" dot={false} />
            </LineChart>
          </ChartFrame>
        )}
      </Section>

      <Section title="Code frequency" hint="Additions and deletions per week, last 52 weeks.">
        {data.codeFrequency.length === 0 ? (
          <EmptyChart pending={data.statsPending} label="No code frequency data yet." />
        ) : (
          <ChartFrame>
            <LineChart data={data.codeFrequency}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.25} />
              <XAxis dataKey="weekStart" tick={axisTick} tickFormatter={shortDate} interval={7} />
              <YAxis tick={axisTick} width={48} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend />
              <Line type="monotone" dataKey="additions" stroke="#8884d8" name="Additions" dot={false} />
              <Line type="monotone" dataKey="deletions" stroke="#82ca9d" name="Deletions" dot={false} />
            </LineChart>
          </ChartFrame>
        )}
      </Section>

      <Section title="Commits by weekday" hint="Last year, default branch.">
        {data.commitFrequency.length === 0 ? (
          <EmptyChart pending={data.statsPending} label="No weekday data yet." />
        ) : (
          <ChartFrame>
            <BarChart data={data.commitFrequency}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.25} />
              <XAxis dataKey="day" tick={axisTick} />
              <YAxis tick={axisTick} allowDecimals={false} width={32} />
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="count" fill="#8884d8" name="Commits" />
            </BarChart>
          </ChartFrame>
        )}
      </Section>

      <Section title="Languages" hint="Bytes reported by GitHub.">
        {data.languages.length === 0 ? (
          <EmptyChart pending={false} label="GitHub has not detected any languages." />
        ) : (
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <ChartFrame>
              <BarChart data={data.languages}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.25} />
                <XAxis dataKey="name" tick={axisTick} interval={0} angle={-30} textAnchor="end" height={70} />
                <YAxis tick={axisTick} width={48} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="bytes" fill="#82ca9d" name="Bytes" />
              </BarChart>
            </ChartFrame>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {data.languages.map((language) => (
                <div key={language.name} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  {languageIcons[language.name] || <FileCode className="text-gray-500" />}
                  <span>
                    {language.name} · {language.percentage}% · {formatBytes(language.bytes)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section
        title="File types"
        hint={data.fileTypesTruncated ? "The file tree was too large, so these counts are partial." : "Top extensions in the repository."}
      >
        {data.fileTypes.length === 0 ? (
          <EmptyChart pending={false} label="No files found." />
        ) : (
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <ChartFrame>
              <BarChart data={data.fileTypes}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.25} />
                <XAxis dataKey="extension" tick={axisTick} interval={0} />
                <YAxis tick={axisTick} allowDecimals={false} width={32} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="count" fill="#8884d8" name="Files" />
              </BarChart>
            </ChartFrame>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {data.fileTypes.map((fileType) => (
                <div key={fileType.extension} className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                  {fileTypeIcon(fileType.extension)}
                  <span>
                    {fileType.extension === "(none)" ? "no extension" : fileType.extension === "other" ? "other" : `.${fileType.extension}`} · {fileType.count.toLocaleString()} (
                    {fileType.percentage}%)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section title="Recent commits" hint="Latest 5 commits, sized by files and lines changed.">
        {data.recentCommits.length === 0 ? (
          <p className="text-sm text-gray-500">This repository has no commits yet.</p>
        ) : (
          <div className="space-y-3">
            {data.recentCommits.map((commit) => (
              <a
                key={commit.sha}
                href={commit.url}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg border border-gray-200 p-4 hover:border-orange-300 dark:border-gray-700 dark:hover:border-orange-800"
              >
                <p className="font-medium">{commit.message}</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {commit.author} · {new Date(commit.date).toLocaleDateString()} · {commit.filesChanged} files · +
                  {commit.additions.toLocaleString()} −{commit.deletions.toLocaleString()}
                </p>
              </a>
            ))}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Issue close time</h3>
          <p className="mt-1 text-2xl font-semibold">
            {data.averageIssueResolutionTime === null ? "—" : `${data.averageIssueResolutionTime} days`}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {data.issueSampleSize === 0
              ? "No closed issues in the latest 100 results."
              : `Average from ${data.issueSampleSize} recently closed issues.`}
          </p>
        </div>
        <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Pull request cycle time</h3>
          <p className="mt-1 text-2xl font-semibold">
            {data.averagePrCycleTime === null ? "—" : `${data.averagePrCycleTime} days`}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {data.prSampleSize === 0
              ? "No merged pull requests in the latest 100 closed."
              : `Open to merge, from ${data.prSampleSize} merged pull requests in the latest 100 closed.`}
          </p>
        </div>
      </div>
    </div>
  );
};

export default RepoInsights;
