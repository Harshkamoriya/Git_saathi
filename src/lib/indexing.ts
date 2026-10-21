import { prisma } from "./db";
import { RepoGenerateEmbeddings } from "./githubLoader";

interface Charge {
  userId: string;
  credits: number;
}

/**
 * Indexes a project and records the final status. When `charge` is given, credits for
 * files that didn't get indexed are refunded, so users only pay for what was indexed.
 */
export async function runIndexing(projectId: string, charge?: Charge) {
  await prisma.project.update({
    where: { id: projectId },
    data: { indexingStatus: "INDEXING" },
  });

  let indexed = 0;
  try {
    const results = await RepoGenerateEmbeddings(projectId);
    indexed = results.length;
    if (indexed === 0) throw new Error("No files could be indexed");

    await prisma.project.update({
      where: { id: projectId },
      data: { indexingStatus: "COMPLETED" },
    });
    console.log(`Indexing completed for ${projectId}: ${indexed} files`);
  } catch (error) {
    console.error(`Indexing failed for ${projectId}:`, error);
    await prisma.project
      .update({ where: { id: projectId }, data: { indexingStatus: "FAILED" } })
      .catch((e) => console.error(`Couldn't mark ${projectId} as FAILED:`, e));
  } finally {
    if (charge) {
      const refund = Math.max(0, charge.credits - indexed);
      if (refund > 0) {
        await prisma.user
          .update({ where: { id: charge.userId }, data: { credits: { increment: refund } } })
          .then(() => console.log(`Refunded ${refund} credits to ${charge.userId}`))
          .catch((e) => console.error(`Refund of ${refund} credits failed for ${charge.userId}:`, e));
      }
    }
  }

  return indexed;
}
