import { NextRequest, NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RepoGenerateEmbeddings } from "@/lib/githubLoader";

/** Re-generate and upload embeddings for a project (needed after embedding model change). */
export async function GET(req: NextRequest) {
  try {
    const session = await getAuthSession();
    // Allow local/dev reindex without session so we can recover broken projects
    if (!session?.user?.id && process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const projectId = req.nextUrl.searchParams.get("projectId");
    if (!projectId) {
      return NextResponse.json(
        { error: "Missing projectId query param" },
        { status: 400 }
      );
    }

    await prisma.project.update({
      where: { id: projectId },
      data: { indexingStatus: "INDEXING" },
    });

    const results = await RepoGenerateEmbeddings(projectId);

    return NextResponse.json({
      message: "Reindex complete",
      projectId,
      embeddedFiles: results.length,
    });
  } catch (error) {
    console.error("Reindex failed:", error);
    const projectId = req.nextUrl.searchParams.get("projectId");
    if (projectId) {
      await prisma.project
        .update({
          where: { id: projectId },
          data: { indexingStatus: "FAILED" },
        })
        .catch(() => undefined);
    }
    return NextResponse.json(
      { error: `Reindex failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
