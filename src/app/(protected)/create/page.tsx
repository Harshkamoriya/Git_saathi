"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Github, Loader2, ArrowRight, Check, AlertTriangle, Search, Coins, FileCode } from "lucide-react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import { checkCreditsAndStructure, fetchUserRepos, type CreditCheck } from "@/lib/githubLoader";
import { parseGithubUrl } from "@/lib/repoRules";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CreateProject } from "@/lib/query";
import { cn } from "@/lib/utils";

interface UserRepo {
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  url: string;
  updatedAt: string | null;
}

type Step = "source" | "select" | "configure";

const STEPS: { id: Step; label: string }[] = [
  { id: "source", label: "Repository" },
  { id: "select", label: "Select" },
  { id: "configure", label: "Confirm" },
];

function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

const CreateProjectPage = () => {
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>("source");
  const [username, setUsername] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [projectName, setProjectName] = useState("");
  const [repos, setRepos] = useState<UserRepo[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<UserRepo | null>(null);
  const [cameFromList, setCameFromList] = useState(false);
  const [check, setCheck] = useState<CreditCheck | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsedUrl = parseGithubUrl(repoUrl);

  const fetchReposMutation = useMutation({
    mutationFn: (name: string) => fetchUserRepos(name),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.repos.length === 0) {
        setError("This user has no public repositories.");
        return;
      }
      setRepos(result.repos);
      setRepoFilter("");
      setSelectedRepo(null);
      setStep("select");
    },
    onError: () => setError("Couldn't reach the server. Check your connection and try again."),
  });

  const checkMutation = useMutation({
    mutationFn: (githubUrl: string) => checkCreditsAndStructure(githubUrl),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCheck(result);
      setProjectName((current) => current || result.repoName);
      setStep("configure");
    },
    onError: () => setError("Couldn't reach the server. Check your connection and try again."),
  });

  const createMutation = useMutation({
    mutationFn: ({ githubUrl, name }: { githubUrl: string; name: string }) => CreateProject(githubUrl, name),
    onSuccess: (result) => {
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success(`${result.project.name} created. Indexing ${result.fileCount} files in the background.`);
      queryClient.invalidateQueries();
      router.push(`/project/${result.project.id}/dashboard`);
    },
    onError: () => {
      const message = "Couldn't reach the server. Check your connection and try again.";
      setError(message);
      toast.error(message);
    },
  });

  const busy = fetchReposMutation.isPending || checkMutation.isPending || createMutation.isPending;

  const filteredRepos = useMemo(() => {
    const q = repoFilter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) => r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q)
    );
  }, [repos, repoFilter]);

  const handleFetchRepos = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    // People often paste a repo URL into the username box
    const asUrl = parseGithubUrl(username);
    if (asUrl && username.includes("/")) {
      setRepoUrl(asUrl.url);
      startCheck(asUrl.url, false);
      return;
    }
    if (!username.trim()) {
      setError("Enter a GitHub username.");
      return;
    }
    fetchReposMutation.mutate(username);
  };

  const startCheck = (githubUrl: string, fromList: boolean) => {
    setError(null);
    setCheck(null);
    setProjectName("");
    setCameFromList(fromList);
    checkMutation.mutate(githubUrl);
  };

  const handleUrlNext = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!parsedUrl) {
      setError("Enter a repository URL like https://github.com/owner/repo.");
      return;
    }
    startCheck(parsedUrl.url, false);
  };

  const handleSelectNext = () => {
    if (!selectedRepo || busy) return;
    startCheck(selectedRepo.url, true);
  };

  const handleCreate = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!check || busy) return;
    if (!projectName.trim()) {
      setError("Project name is required.");
      return;
    }
    setError(null);
    createMutation.mutate({ githubUrl: check.githubUrl, name: projectName });
  };

  const goBack = () => {
    setError(null);
    if (step === "configure") {
      setCheck(null);
      setStep(cameFromList ? "select" : "source");
    } else {
      setStep("source");
    }
  };

  const enoughCredits = check ? check.fileCount <= check.userCredits : true;
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="flex w-full items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200 p-4 sm:p-6 dark:from-gray-900 dark:to-gray-800">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex w-full max-w-4xl flex-col gap-8 rounded-xl bg-white p-6 shadow-2xl sm:p-8 md:flex-row dark:bg-gray-900"
      >
        <div className="flex flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 p-6 text-white">
          <div className="text-center">
            <div className="mb-6 inline-block rounded-full bg-white/10 p-6">
              {createMutation.isPending ? (
                <Loader2 size={60} className="animate-spin" />
              ) : (
                <Github size={60} />
              )}
            </div>
            <h3 className="mb-2 text-2xl font-bold">
              {createMutation.isPending ? "Setting up your project" : "Connect your repository"}
            </h3>
            <p className="text-white/80">
              {createMutation.isPending
                ? "Indexing continues in the background once the project opens."
                : "Link a public GitHub repo for AI-powered Q&A, commit summaries and more."}
            </p>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-gray-800 sm:text-3xl dark:text-gray-100">
            {step === "source" && "Connect Repository"}
            {step === "select" && "Select Repository"}
            {step === "configure" && "Confirm Project"}
          </h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {step === "source" && "Enter a GitHub username or paste a repository URL."}
            {step === "select" && `Public repositories for ${username.trim()}.`}
            {step === "configure" && "Review the credit cost and name your project."}
          </p>

          <ol className="my-6 flex items-center gap-2">
            {STEPS.map((s, i) => (
              <li key={s.id} className="flex flex-1 items-center gap-2 last:flex-none">
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium",
                    i <= stepIndex
                      ? "bg-gradient-to-r from-orange-500 to-pink-500 text-white"
                      : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                  )}
                >
                  {i < stepIndex ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span className="hidden text-xs text-gray-500 sm:inline dark:text-gray-400">{s.label}</span>
                {i < STEPS.length - 1 && (
                  <span
                    className={cn(
                      "h-1 flex-1 rounded",
                      i < stepIndex ? "bg-gradient-to-r from-orange-500 to-pink-500" : "bg-gray-200 dark:bg-gray-700"
                    )}
                  />
                )}
              </li>
            ))}
          </ol>

          {step === "source" && (
            <>
              <form onSubmit={handleFetchRepos}>
                <label className="mb-2 block font-medium text-gray-700 dark:text-gray-300">GitHub username</label>
                <div className="flex gap-3">
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. vercel"
                    autoFocus
                    className="flex-1"
                  />
                  <Button
                    type="submit"
                    disabled={busy || !username.trim()}
                    className="bg-gradient-to-r from-orange-500 to-pink-500 text-white"
                  >
                    {fetchReposMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
                    Fetch repos
                  </Button>
                </div>
              </form>

              <div className="my-5 text-center text-sm text-gray-500 dark:text-gray-400">OR</div>

              <form onSubmit={handleUrlNext}>
                <label className="mb-2 block font-medium text-gray-700 dark:text-gray-300">Repository URL</label>
                <div className="flex gap-3">
                  <Input
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="flex-1"
                  />
                  <Button
                    type="submit"
                    disabled={busy || !parsedUrl}
                    className="bg-gradient-to-r from-orange-500 to-pink-500 text-white"
                  >
                    {checkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    Next
                  </Button>
                </div>
                {repoUrl.trim() && !parsedUrl && (
                  <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                    Use the format https://github.com/owner/repo
                  </p>
                )}
              </form>
              {checkMutation.isPending && (
                <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">Counting files in the repository…</p>
              )}
              <ErrorBox message={error} />
            </>
          )}

          {step === "select" && (
            <>
              <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <Input
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder={`Search ${repos.length} repositories`}
                  className="pl-9"
                />
              </div>
              <div className="mb-6 h-[300px] space-y-2 overflow-y-auto rounded-md border border-gray-300 p-3 dark:border-gray-600">
                {filteredRepos.length === 0 && (
                  <p className="py-10 text-center text-sm text-gray-500">No repositories match “{repoFilter}”.</p>
                )}
                {filteredRepos.map((repo) => (
                  <button
                    key={repo.fullName}
                    type="button"
                    onClick={() => setSelectedRepo(repo)}
                    onDoubleClick={() => {
                      setSelectedRepo(repo);
                      startCheck(repo.url, true);
                    }}
                    className={cn(
                      "w-full rounded-md p-3 text-left transition-colors",
                      selectedRepo?.fullName === repo.fullName
                        ? "border-2 border-orange-500 bg-orange-50 dark:bg-orange-900/30"
                        : "border border-gray-300 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-800"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-gray-800 dark:text-gray-200">{repo.name}</span>
                      {repo.updatedAt && (
                        <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                          {formatDistanceToNow(new Date(repo.updatedAt), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
                      {repo.description || "No description"}
                    </p>
                  </button>
                ))}
              </div>

              <div className="flex justify-between">
                <Button type="button" variant="outline" onClick={goBack} disabled={busy}>
                  Back
                </Button>
                <Button
                  type="button"
                  onClick={handleSelectNext}
                  disabled={busy || !selectedRepo}
                  className="bg-gradient-to-r from-orange-500 to-pink-500 text-white"
                >
                  {checkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  {checkMutation.isPending ? "Counting files…" : "Next"}
                </Button>
              </div>
              <ErrorBox message={error} />
            </>
          )}

          {step === "configure" && check && (
            <form onSubmit={handleCreate}>
              <div className="mb-6 space-y-4">
                <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
                  <Github className="h-4 w-4 shrink-0 text-gray-500" />
                  <a
                    href={check.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-gray-700 hover:text-orange-500 dark:text-gray-300"
                  >
                    {check.githubUrl.replace("https://github.com/", "")}
                  </a>
                  <span className="ml-auto shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    {check.defaultBranch}
                  </span>
                </div>

                <div>
                  <label className="mb-2 block font-medium text-gray-700 dark:text-gray-300">Project name</label>
                  <Input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="Enter project name"
                    maxLength={80}
                    autoFocus
                  />
                </div>

                <div
                  className={cn(
                    "rounded-lg border p-4",
                    enoughCredits
                      ? "border-orange-200 bg-orange-50 dark:border-orange-700 dark:bg-orange-900/30"
                      : "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/30"
                  )}
                >
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                      <FileCode className="h-4 w-4 text-orange-500" />
                      <span>
                        <strong>{check.fileCount}</strong> files to index
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                      <Coins className="h-4 w-4 text-orange-500" />
                      <span>
                        <strong>{check.userCredits}</strong> credits available
                      </span>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
                    {enoughCredits
                      ? `Costs ${check.fileCount} credits, leaving ${check.userCredits - check.fileCount}. You're refunded for any file that fails to index.`
                      : `You need ${check.fileCount - check.userCredits} more credits to index this repository.`}
                    {check.skippedFiles > 0 && ` ${check.skippedFiles} files (lockfiles, images, build output) are skipped and free.`}
                  </p>
                </div>

                {check.alreadyAdded && (
                  <p className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" />
                    You&apos;ve already added this repository as a project.
                  </p>
                )}
              </div>

              <div className="flex justify-between">
                <Button type="button" variant="outline" onClick={goBack} disabled={busy}>
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !enoughCredits || !projectName.trim() || check.alreadyAdded}
                  className="bg-gradient-to-r from-orange-500 to-pink-500 text-white"
                >
                  {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {createMutation.isPending ? "Creating…" : "Create project"}
                </Button>
              </div>
              <ErrorBox message={error} />
            </form>
          )}
        </div>
      </motion.div>
    </div>
  );
};

export default CreateProjectPage;
