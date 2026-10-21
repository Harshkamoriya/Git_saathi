import { NextRequest, NextResponse, after } from "next/server";
import { getAuthSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { runIndexing } from "@/lib/indexing";

const STALE_INDEXING_MS = 30 * 60 * 1000;

/** Re-generate and upload embeddings for a project. Runs in the background; poll indexingStatus. */
export async function GET(req: NextRequest) {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "Missing projectId query param" }, { status: 400 });
  }

  try {
    const membership = await prisma.userToProject.findUnique({
      where: { userId_projectId: { userId, projectId } },
      select: { project: { select: { indexingStatus: true, deletedAt: true, updatedAt: true } } },
    });
    if (!membership || membership.project.deletedAt) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    // A run that died mid-way (server restart) leaves INDEXING behind; let it be retried after a while
    const stale = Date.now() - membership.project.updatedAt.getTime() > STALE_INDEXING_MS;
    if (membership.project.indexingStatus === "INDEXING" && !stale) {
      return NextResponse.json({ error: "This project is already being indexed." }, { status: 409 });
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { indexingStatus: "INDEXING" },
    });
    after(() => runIndexing(projectId));

    return NextResponse.json({ message: "Reindex started", projectId }, { status: 202 });
  } catch (error) {
    console.error("Reindex failed to start:", error);
    return NextResponse.json({ error: "Couldn't start reindexing. Please try again." }, { status: 500 });
  }
}
