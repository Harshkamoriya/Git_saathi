import { PrismaClient } from "@prisma/client";
import { Pinecone } from "@pinecone-database/pinecone";

const prisma = new PrismaClient();
const recent = await prisma.project.findMany({
  orderBy: { createdAt: "desc" },
  take: 10,
  select: {
    id: true,
    name: true,
    githubUrl: true,
    indexingStatus: true,
    createdAt: true,
  },
});
console.log("RECENT_PROJECTS:", JSON.stringify(recent, null, 2));

const verviqId = "cmuzh5kem000bf30o93etbe8f";
const verviq = await prisma.project.findUnique({
  where: { id: verviqId },
  include: {
    users: { include: { user: { select: { email: true, name: true } } } },
    _count: { select: { commits: true, meetings: true } },
  },
});
console.log("VERVIQ:", JSON.stringify(verviq, null, 2));

if (process.env.PINECONE_API_KEY) {
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const stats = await pc.index("gitbuddy").describeIndexStats();
  console.log("VERVIQ_NS:", JSON.stringify(stats.namespaces?.[verviqId] || null));
  const saathi = recent.find((p) => /saathi/i.test(p.name) || /saathi/i.test(p.githubUrl || ""));
  if (saathi) {
    console.log("SAATHI_PROJECT:", saathi.id, saathi.name, saathi.indexingStatus);
    console.log("SAATHI_NS:", JSON.stringify(stats.namespaces?.[saathi.id] || null));
  }
}

await prisma.$disconnect();
