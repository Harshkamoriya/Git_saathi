"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ExternalLink,
  GitCommit,
  Loader2,
  LogOut,
  MoreVertical,
  Plus,
  RotateCw,
  Search,
  Users,
  Video,
} from "lucide-react";
import { ArchiveProject, GetAllProjects, LeaveProject, type ProjectSummary } from "@/lib/query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type SortKey = "recent" | "name" | "created";

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  COMPLETED: {
    label: "Ready",
    className: "bg-green-500/10 text-green-700 border-green-200 dark:text-green-400 dark:border-green-900/50",
  },
  INDEXING: {
    label: "Indexing",
    className: "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-300 dark:border-orange-900/50",
  },
  PENDING: {
    label: "Pending",
    className: "bg-yellow-500/10 text-yellow-700 border-yellow-200 dark:text-yellow-400 dark:border-yellow-900/50",
  },
  FAILED: {
    label: "Indexing failed",
    className: "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900/50",
  },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.PENDING;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-xs", style.className)}>
      {status === "INDEXING" && <Loader2 className="h-3 w-3 animate-spin" />}
      {style.label}
    </span>
  );
}

function Stat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2 rounded border border-orange-200 bg-orange-50 px-2 py-1.5 dark:border-orange-900/50 dark:bg-orange-900/20">
      <Icon className="h-4 w-4 shrink-0 text-orange-500" />
      <span className="text-sm text-gray-700 dark:text-gray-300">
        <strong>{value}</strong> {label}
      </span>
    </div>
  );
}

function ProjectsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
      {[1, 2, 3].map((i) => (
        <Card key={i} className="border-orange-200 bg-white dark:border-orange-900/50 dark:bg-gray-800">
          <CardHeader>
            <div className="flex items-start justify-between">
              <Skeleton className="h-6 w-3/4" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-32" />
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const Projects = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [pending, setPending] = useState<{ project: ProjectSummary; action: "archive" | "leave" } | null>(null);

  const { data: projects, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["projects"],
    queryFn: () => GetAllProjects(),
    refetchInterval: (query) =>
      query.state.data?.some((p) => p.indexingStatus === "INDEXING") ? 5000 : false,
  });

  const actionMutation = useMutation({
    mutationFn: async ({ project, action }: { project: ProjectSummary; action: "archive" | "leave" }) => {
      const result = action === "archive" ? await ArchiveProject(project.id) : await LeaveProject(project.id);
      if (!result.ok) throw new Error(result.error);
      return { project, action };
    },
    onSuccess: ({ project, action }) => {
      toast.success(action === "archive" ? `${project.name} archived.` : `You left ${project.name}.`);
      queryClient.setQueryData<ProjectSummary[]>(["projects"], (old) => old?.filter((p) => p.id !== project.id));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.removeQueries({ queryKey: ["project", project.id] });
      setPending(null);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (projects ?? []).filter(
      (p) => !q || p.name.toLowerCase().includes(q) || p.githubUrl?.toLowerCase().includes(q)
    );
    return [...list].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "created") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [projects, search, sort]);

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="bg-gradient-to-r from-orange-500 to-pink-500 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent sm:text-4xl">
            Your Projects
          </h1>
          {projects && projects.length > 0 && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {projects.length} project{projects.length === 1 ? "" : "s"} you created or joined
            </p>
          )}
        </div>
        <Button asChild className="bg-gradient-to-r from-orange-500 to-pink-500 text-white">
          <Link href="/create">
            <Plus className="h-4 w-4" />
            New project
          </Link>
        </Button>
      </div>

      {projects && projects.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or repository"
              className="pl-9"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm dark:bg-input/30"
            aria-label="Sort projects"
          >
            <option value="recent">Recently updated</option>
            <option value="created">Newest first</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      )}

      {isLoading && <ProjectsSkeleton />}

      {isError && !projects && (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="text-gray-600 dark:text-gray-300">Couldn&apos;t load your projects.</p>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
            Try again
          </Button>
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-orange-300 py-16 text-center dark:border-orange-900/60">
          <p className="text-lg font-medium text-gray-700 dark:text-gray-200">No projects yet</p>
          <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">
            Connect a GitHub repository to get AI answers about the code, commit summaries and meeting notes.
          </p>
          <Button asChild className="bg-gradient-to-r from-orange-500 to-pink-500 text-white">
            <Link href="/create">
              <Plus className="h-4 w-4" />
              Create your first project
            </Link>
          </Button>
        </div>
      )}

      {projects && projects.length > 0 && visible.length === 0 && (
        <p className="py-16 text-center text-gray-500 dark:text-gray-400">No projects match “{search}”.</p>
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <Card
              key={project.id}
              className="relative border-orange-200 bg-white transition-all hover:shadow-lg focus-within:ring-2 focus-within:ring-orange-500 dark:border-orange-900/50 dark:bg-gray-800"
            >
              <Link
                href={`/project/${project.id}/dashboard`}
                className="absolute inset-0 z-0 rounded-xl focus:outline-none"
                aria-label={`Open ${project.name}`}
              />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="line-clamp-1 text-xl font-semibold text-orange-500 dark:text-orange-400">
                    {project.name}
                  </CardTitle>
                  <div className="relative z-10 flex items-center gap-1">
                    <StatusBadge status={project.indexingStatus} />
                    {/* Non-modal so opening the confirm dialog from a menu item doesn't leave the page unclickable */}
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Project actions">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {project.githubUrl && (
                          <DropdownMenuItem asChild>
                            <a href={project.githubUrl} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4" />
                              Open on GitHub
                            </a>
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        {project.isOwner ? (
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onSelect={() => setPending({ project, action: "archive" })}
                          >
                            <Archive className="h-4 w-4" />
                            Archive project
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onSelect={() => setPending({ project, action: "leave" })}
                          >
                            <LogOut className="h-4 w-4" />
                            Leave project
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
                  {project.githubUrl && (
                    <p className="truncate text-gray-500 dark:text-gray-400">
                      {project.githubUrl.replace("https://github.com/", "")}
                    </p>
                  )}
                  <p>
                    Updated {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
                    <span className="mx-1.5 text-gray-300 dark:text-gray-600">·</span>
                    {project.isOwner
                      ? "Created by you"
                      : `Joined ${formatDistanceToNow(new Date(project.joinedAt), { addSuffix: true })}`}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Stat icon={GitCommit} label="commits" value={project.counts.commits} />
                  <Stat icon={Video} label="meetings" value={project.counts.meetings} />
                  <Stat icon={Users} label={project.counts.members === 1 ? "member" : "members"} value={project.counts.members} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!pending} onOpenChange={(open) => !open && !actionMutation.isPending && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.action === "archive" ? `Archive ${pending.project.name}?` : `Leave ${pending?.project.name}?`}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {pending?.action === "archive"
              ? "The project will disappear for you and every member. Its commits, meetings and index are kept, but nobody will be able to open it."
              : "The project will be removed from your list. You can rejoin later with an invite link."}
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPending(null)} disabled={actionMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={actionMutation.isPending}
              onClick={() => pending && actionMutation.mutate(pending)}
            >
              {actionMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {pending?.action === "archive" ? "Archive" : "Leave"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Projects;
