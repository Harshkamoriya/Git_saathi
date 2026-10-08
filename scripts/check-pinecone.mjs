import { PrismaClient } from "@prisma/client";
import { Pinecone } from "@pinecone-database/pinecone";

const projectId = process.argv[2] || "cmuzebhpx0000f30ondyihr3r";
const prisma = new PrismaClient();
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

const project = await prisma.project.findUnique({
  where: { id: projectId },
  select: {
    id: true,
    name: true,
    githubUrl: true,
    indexingStatus: true,
    createdAt: true,
  },
});
console.log("PROJECT:", JSON.stringify(project, null, 2));

const index = pc.index("gitbuddy");
const stats = await index.describeIndexStats();
console.log("INDEX_DIMS:", stats.dimension);
console.log("TOTAL_VECTORS:", stats.totalRecordCount);
console.log("ALL_NAMESPACES:", JSON.stringify(stats.namespaces || {}, null, 2));
console.log("THIS_PROJECT_NS:", JSON.stringify(stats.namespaces?.[projectId] || null));

if (stats.dimension) {
  const zeros = Array(stats.dimension).fill(0);
  try {
    const q = await index.namespace(projectId).query({
      vector: zeros,
      topK: 5,
      includeMetadata: true,
    });
    console.log("PROBE_MATCH_COUNT:", q.matches?.length ?? 0);
    console.log(
      "PROBE_MATCHES:",
      JSON.stringify(
        (q.matches || []).map((m) => ({
          id: m.id,
          score: m.score,
          file: m.metadata?.fileName,
        })),
        null,
        2
      )
    );
  } catch (e) {
    console.log("PROBE_ERROR:", e.message);
  }
}

await prisma.$disconnect();
