import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import { RepoGenerateEmbeddings } from "../src/lib/githubLoader";
import { prisma } from "../src/lib/db";

const projectId = process.argv[2];
if (!projectId) {
  console.error("Usage: npx tsx scripts/reindex-project.ts <projectId>");
  process.exit(1);
}

async function main() {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, githubUrl: true, indexingStatus: true },
  });
  if (!project) throw new Error(`Project not found: ${projectId}`);

  console.log("Reindexing project:", project);
  await prisma.project.update({
    where: { id: projectId },
    data: { indexingStatus: "INDEXING" },
  });

  const results = await RepoGenerateEmbeddings(projectId);
  console.log(`Done. Embedded ${results.length} files.`);

  const updated = await prisma.project.findUnique({
    where: { id: projectId },
    select: { indexingStatus: true },
  });
  console.log("Final indexingStatus:", updated?.indexingStatus);
}

main()
  .catch(async (e) => {
    console.error("Reindex failed:", e);
    try {
      await prisma.project.update({
        where: { id: projectId },
        data: { indexingStatus: "FAILED" },
      });
    } catch {}
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
