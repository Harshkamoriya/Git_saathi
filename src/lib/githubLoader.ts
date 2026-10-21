"use server";
import { GithubRepoLoader } from '@langchain/community/document_loaders/web/github';
import { Octokit } from "octokit";
import { prisma } from "./db";
import { getAuthSession } from "./auth";
import { Document } from '@langchain/core/documents';
import {  summariseCode } from './gemini';
import { uploadToPinecone } from './pineconedb';
import { PineconeRecord } from '@pinecone-database/pinecone';
import { generateEmbedding } from './repoEmbedding';
import { summariseCode_2 } from './gemini2';
import { ignorePathPatterns, parseGithubUrl, shouldIndexPath } from './repoRules';


const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

function textForEmbedding(fileName: string, summary: string, source: string) {
  if (/could not be determined due to an error/i.test(summary)) {
    return `File: ${fileName}\n${source.slice(0, 8000)}`;
  }
  return summary;
}

function githubErrorMessage(error: unknown, notFound: string): string {
  const status = (error as { status?: number })?.status;
  if (status === 404) return notFound;
  if (status === 403 || status === 429) {
    return "GitHub rate limit reached. Please wait a few minutes and try again.";
  }
  if (status === 401) return "The server's GitHub token is invalid. Check GITHUB_TOKEN in .env.local.";
  return "Couldn't reach GitHub right now. Please try again.";
}

async function getRepoInfo(owner: string, repo: string) {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return {
    owner: data.owner.login,
    repo: data.name,
    url: `https://github.com/${data.owner.login}/${data.name}`,
    defaultBranch: data.default_branch,
    isEmpty: data.size === 0,
  };
}

// One Git Trees call instead of walking every folder with getContent
async function countIndexableFiles(owner: string, repo: string, branch: string) {
  const { data } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: "true",
  });
  const files = data.tree.filter((item) => item.type === "blob" && item.path);
  const indexable = files.filter((item) => shouldIndexPath(item.path!)).length;
  return { indexable, total: files.length, truncated: data.truncated };
}

interface UserRepo {
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  url: string;
  updatedAt: string | null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export const fetchUserRepos = async (
  username: string
): Promise<Result<{ repos: UserRepo[] }>> => {
  const session = await getAuthSession();
  if (!session?.user?.id) return { ok: false, error: "Please sign in again." };

  const name = username.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(name)) {
    return { ok: false, error: "That doesn't look like a GitHub username." };
  }

  try {
    const data = await octokit.paginate(octokit.rest.repos.listForUser, {
      username: name,
      per_page: 100,
      sort: "updated",
    });
    const repos: UserRepo[] = data.map((repo) => ({
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description ?? null,
      private: !!repo.private,
      url: `https://github.com/${repo.full_name}`,
      updatedAt: repo.pushed_at ?? repo.updated_at ?? null,
    }));
    return { ok: true, repos };
  } catch (error) {
    console.error(`Error fetching repositories for ${name}:`, error);
    return { ok: false, error: githubErrorMessage(error, `GitHub user "${name}" was not found.`) };
  }
};

export interface CreditCheck {
  fileCount: number;
  skippedFiles: number;
  userCredits: number;
  githubUrl: string;
  repoName: string;
  defaultBranch: string;
  alreadyAdded: boolean;
}

export async function checkCreditsAndStructure(githubUrl: string): Promise<Result<CreditCheck>> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Please sign in again." };

  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) {
    return { ok: false, error: "Enter a repository URL like https://github.com/owner/repo." };
  }

  let info: Awaited<ReturnType<typeof getRepoInfo>>;
  try {
    info = await getRepoInfo(parsed.owner, parsed.repo);
  } catch (error) {
    console.error(`Repo lookup failed for ${parsed.url}:`, error);
    return {
      ok: false,
      error: githubErrorMessage(error, "Repository not found. Check the URL, and note that private repos aren't supported yet."),
    };
  }

  if (info.isEmpty) return { ok: false, error: "This repository is empty, so there's nothing to index." };

  let counts: Awaited<ReturnType<typeof countIndexableFiles>>;
  try {
    counts = await countIndexableFiles(info.owner, info.repo, info.defaultBranch);
  } catch (error) {
    console.error(`File count failed for ${info.url}:`, error);
    return { ok: false, error: githubErrorMessage(error, "Couldn't read this repository's files.") };
  }

  if (counts.truncated) {
    return { ok: false, error: "This repository is too large to index right now." };
  }
  if (counts.indexable === 0) {
    return { ok: false, error: "No source files found to index in this repository." };
  }

  const [user, existing] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { credits: true } }),
    prisma.userToProject.findFirst({
      where: {
        userId,
        project: { deletedAt: null, githubUrl: { equals: info.url, mode: "insensitive" } },
      },
      select: { id: true },
    }),
  ]);

  return {
    ok: true,
    fileCount: counts.indexable,
    skippedFiles: counts.total - counts.indexable,
    userCredits: user?.credits ?? 0,
    githubUrl: info.url,
    repoName: info.repo,
    defaultBranch: info.defaultBranch,
    alreadyAdded: !!existing,
  };
}

export const loadGithubRepo = async (githubUrl: string) => {
  const parsed = parseGithubUrl(githubUrl);
  if (!parsed) throw new Error(`Invalid GitHub URL: ${githubUrl}`);
  const { defaultBranch } = await getRepoInfo(parsed.owner, parsed.repo);

  const loader = new GithubRepoLoader(parsed.url, {
    branch: defaultBranch,
    accessToken: process.env.GITHUB_TOKEN || "",
    ignorePaths: ignorePathPatterns(),
    recursive: true,
    unknown: "warn",
    maxConcurrency: 3, // Reduced concurrency to minimize rate limit issues
  });

  // Fetch files with retry logic for rate limits
  let docs: Document[] = [];
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      docs = await loader.load();
      break;
    } catch (error: any) {
      if (error.message.includes("rate limit") || error.response?.status === 403) {
        if (attempt === MAX_RETRIES) {
          console.error(`Failed to load GitHub repo after ${MAX_RETRIES} attempts:`, error);
          throw new Error(
            "GitHub API rate limit exceeded. Please try again later or check the repository directly.",
          );
        }
        const retryDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`GitHub API rate limit hit. Retrying after ${retryDelay}ms...`);
        await delay(retryDelay);
      } else {
        console.error("Error loading GitHub repo:", error);
        throw error;
      }
    }
  }
  return docs.filter((doc) => shouldIndexPath(doc.metadata.source || ""));
};


const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Configuration for rate limiting and processing
const BATCH_SIZE = 4; // Adjust based on API limits
const DELAY_BETWEEN_BATCHES_MS = 1000; // 1 second delay between batches
const MAX_RETRIES = 3; // Number of retry attempts for rate limit errors
const BASE_RETRY_DELAY_MS = 1000; // Base delay for retries
// Pinecone rejects records whose metadata exceeds 40KB
const MAX_METADATA_SOURCE_CHARS = 20000;
const MAX_METADATA_SUMMARY_CHARS = 8000;

export interface EmbeddingResult {
  summary: string;
  embedding: number[];
  sourceCode: string;
  fileName: string;
}

/**
 * Generates embeddings for a repository and uploads them to Pinecone.
 * Returns only the files whose vectors were actually stored.
 * @param projectId - Unique identifier for the project (used as Pinecone namespace)
 */

export const RepoGenerateEmbeddings = async (
  projectId: string,
): Promise<EmbeddingResult[]> => {
  const embeddings: EmbeddingResult[] = [];
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { githubUrl: true },
  });
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const docs = await loadGithubRepo(project.githubUrl!);

  if (!docs) {
    throw new Error("Failed to load documents from the repository.");
  }

  const totalBatches = Math.ceil(docs.length / BATCH_SIZE);
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const batchNumber = i / BATCH_SIZE + 1;
    console.log(`Processing batch ${batchNumber} of ${totalBatches}`);
    // Alternate between the two summariser clients to spread rate limits
    const summarise = batchNumber % 2 === 0 ? summariseCode : summariseCode_2;

    const batchPromises = batch.map(async (doc): Promise<EmbeddingResult | null> => {
      const fileName = doc.metadata.source || "unknown file";
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const summary = await summarise(doc);
          const embedding = await generateEmbedding(
            textForEmbedding(fileName, summary, doc.pageContent)
          );
          return { summary, embedding, sourceCode: doc.pageContent, fileName };
        } catch (error: any) {
          const rateLimited = error?.response?.status === 429 || /rate limit|429/i.test(error?.message || "");
          if (!rateLimited || attempt === MAX_RETRIES) {
            console.error(`Failed to embed ${fileName} (attempt ${attempt}):`, error?.message || error);
            return null;
          }
          const retryDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`Rate limit hit for ${fileName}. Retrying (${attempt}/${MAX_RETRIES}) after ${retryDelay}ms...`);
          await delay(retryDelay);
        }
      }
      return null;
    });

    const batchResults = await Promise.all(batchPromises);
    const successfulResults = batchResults.filter(
      (item): item is EmbeddingResult => item !== null
    );

    if (successfulResults.length > 0) {
      const vectors: PineconeRecord[] = successfulResults.map((result) => ({
        id: `${projectId}_${result.fileName.replace(/[^a-zA-Z0-9-_]/g, "_")}`,
        values: result.embedding,
        metadata: {
          fileName: result.fileName,
          sourceCode: result.sourceCode.slice(0, MAX_METADATA_SOURCE_CHARS),
          summary: result.summary.slice(0, MAX_METADATA_SUMMARY_CHARS),
          projectId,
        },
      }));

      try {
        await uploadToPinecone(vectors, projectId);
        embeddings.push(...successfulResults);
        console.log(`Uploaded ${vectors.length} embeddings to Pinecone for project ${projectId}`);
      } catch (error) {
        console.error(`Failed to upload batch ${batchNumber} to Pinecone for project ${projectId}:`, error);
      }
    }

    if (i + BATCH_SIZE < docs.length) {
      await delay(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`Indexed ${embeddings.length} of ${docs.length} files for project ${projectId}`);
  return embeddings;
};
