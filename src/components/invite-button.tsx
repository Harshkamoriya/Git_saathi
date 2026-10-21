"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createInvite, listInvites, revokeInvite, type InviteLink } from "@/lib/query";

const InviteButton = ({ projectId }: { projectId: string }) => {
  const [open, setOpen] = useState(false);
  const [invites, setInvites] = useState<InviteLink[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [copying, setCopying] = useState(false);

  const linkFor = (token: string) => (typeof window === "undefined" ? "" : `${window.location.origin}/join/${token}`);

  const load = async () => {
    setLoading(true);
    const result = await listInvites(projectId);
    setLoading(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setInvites(result.invites);
    const active = result.invites.find((invite) => invite.status === "active");
    setSelected((current) => current || active?.token || "");
  };

  const handleCreate = async () => {
    setCreating(true);
    const result = await createInvite(projectId);
    setCreating(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setInvites((current) => [result.invite, ...current]);
    setSelected(result.invite.token);
    toast.success("Invite link created. It expires in 7 days.");
  };

  const handleCopy = async () => {
    if (!selected) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(linkFor(selected));
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    } finally {
      setCopying(false);
    }
  };

  const handleRevoke = async (inviteId: string) => {
    const result = await revokeInvite(inviteId);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setInvites((current) => current.map((invite) => (invite.id === inviteId ? { ...invite, status: "revoked" } : invite)));
    toast.success("Invite revoked");
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) load();
        }}
      >
        <DialogContent className="bg-white dark:bg-gray-800">
          <DialogHeader>
            <DialogTitle>Invite team members</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Links work for 7 days and 10 people. Revoke a link to stop it. Knowing the project URL is not enough to join.
          </p>
          <div className="mt-4 flex items-center gap-2">
            <Input readOnly value={selected ? linkFor(selected) : ""} placeholder="Create a link to share" />
            <Button size="sm" onClick={handleCopy} disabled={!selected || copying} className="bg-gradient-to-r from-orange-500 to-pink-500 text-white">
              {copying ? <Loader2 className="size-4 animate-spin" /> : "Copy"}
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={handleCreate} disabled={creating} className="mt-3">
            {creating ? "Creating…" : "New link"}
          </Button>
          <div className="mt-4 space-y-2">
            {loading ? <p className="text-sm text-gray-500">Loading links…</p> : null}
            {!loading && invites.length === 0 ? <p className="text-sm text-gray-500">No invite links yet.</p> : null}
            {invites.map((invite) => (
              <div key={invite.id} className="flex items-center justify-between gap-2 text-sm">
                <button type="button" className="truncate text-left hover:underline" onClick={() => setSelected(invite.token)}>
                  {invite.status === "active"
                    ? `${invite.useCount}/${invite.maxUses} used · expires ${new Date(invite.expiresAt).toLocaleDateString()}`
                    : invite.status}
                </button>
                {invite.status === "active" ? (
                  <Button variant="ghost" size="sm" onClick={() => handleRevoke(invite.id)}>
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        className="bg-gradient-to-r from-orange-500 to-pink-500 text-white"
      >
        Invite Member
      </Button>
    </>
  );
};

export default InviteButton;
