"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { joinWithInvite, previewInvite } from "@/lib/query";

const STATUS_COPY: Record<string, string> = {
  expired: "This invite link has expired. Ask the project owner for a new one.",
  revoked: "This invite link was revoked. Ask the project owner for a new one.",
  used: "This invite link has been used up. Ask the project owner for a new one.",
};

const JoinProjectPage = () => {
  const router = useRouter();
  const params = useParams();
  const token = typeof params.token === "string" ? params.token : "";
  const { status } = useSession();
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<"active" | "expired" | "revoked" | "used" | null>(null);

  useEffect(() => {
    if (!token) {
      setError("This invite link is not valid.");
      setLoading(false);
      return;
    }
    if (status === "loading") return;
    if (status === "unauthenticated") {
      router.replace(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
      return;
    }

    let cancelled = false;
    previewInvite(token).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
      } else if (!result.signedIn) {
        router.replace(`/login?callbackUrl=${encodeURIComponent(`/join/${token}`)}`);
        return;
      } else {
        setProjectName(result.projectName);
        setProjectId(result.projectId);
        setAlreadyMember(result.alreadyMember);
        setInviteStatus(result.status);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token, status, router]);

  const handleJoin = async () => {
    setJoining(true);
    const result = await joinWithInvite(token);
    setJoining(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(result.alreadyMember ? "You're already on this project." : "You joined the project.");
    router.push(`/project/${result.projectId}/qa`);
  };

  if (status === "loading" || loading) {
    return <div className="px-6 py-16 text-center text-sm text-gray-500">Loading invite…</div>;
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h1 className="text-2xl font-semibold text-gray-800 dark:text-gray-100">Invite unavailable</h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{error}</p>
      </div>
    );
  }

  const blocked = inviteStatus && inviteStatus !== "active" ? STATUS_COPY[inviteStatus] : null;

  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold text-gray-800 dark:text-gray-100">Join {projectName}</h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {alreadyMember
          ? "You're already a member of this project."
          : blocked || "You've been invited to this project."}
      </p>
      {alreadyMember ? (
        <Button className="mt-6 bg-gradient-to-r from-orange-500 to-pink-500 text-white" onClick={() => router.push(`/project/${projectId}/qa`)}>
          Open project
        </Button>
      ) : blocked ? null : (
        <Button className="mt-6 bg-gradient-to-r from-orange-500 to-pink-500 text-white" onClick={handleJoin} disabled={joining}>
          {joining ? "Joining…" : "Join project"}
        </Button>
      )}
    </div>
  );
};

export default JoinProjectPage;
