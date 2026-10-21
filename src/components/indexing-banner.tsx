"use client";

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { GetProjectById } from "@/lib/query";
import { Button } from "@/components/ui/button";

const POLL_MS = 5000;

export default function IndexingBanner() {
  const params = useParams<{ projectId?: string }>();
  const projectId = params?.projectId;
  const queryClient = useQueryClient();
  const previousStatus = useRef<string | undefined>(undefined);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => GetProjectById(projectId!),
    enabled: !!projectId,
    refetchInterval: (query) =>
      query.state.data?.indexingStatus === "INDEXING" ? POLL_MS : false,
  });

  const status = project?.indexingStatus;

  useEffect(() => {
    if (previousStatus.current === "INDEXING" && status === "COMPLETED") {
      toast.success(`${project?.name ?? "Project"} is ready. You can ask questions now.`);
    }
    if (previousStatus.current === "INDEXING" && status === "FAILED") {
      toast.error(`Indexing ${project?.name ?? "the project"} failed. You can try again from the banner.`);
    }
    previousStatus.current = status;
  }, [status, project?.name]);

  const reindex = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/reindex?projectId=${projectId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't start reindexing.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: (error: Error) => toast.error(error.message),
  });

  if (!project || status === "COMPLETED" || status === "PENDING") return null;

  if (status === "INDEXING") {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-200">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span>
          Indexing <strong>{project.name}</strong>. This usually takes a few minutes for small repos.
          Ask me will work once it finishes; everything else is usable now.
        </span>
      </div>
    );
  }

  if (status === "FAILED") {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          Indexing <strong>{project.name}</strong> failed. You&apos;re only charged for files that were indexed.
        </span>
        <Button size="sm" variant="outline" disabled={reindex.isPending} onClick={() => reindex.mutate()}>
          {reindex.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Try again"}
        </Button>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      <span>Indexing status: {status}</span>
    </div>
  );
}
