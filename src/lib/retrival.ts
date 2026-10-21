"use server";

import { createStreamableValue } from "ai/rsc";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { getPineconeClient } from "@/lib/pineconedb";
import { prisma } from "@/lib/db";
import { getAuthSession } from "./auth";

import { generateEmbedding } from "./repoEmbedding";
import { Octokit } from "octokit";


// interface FileReference {
//   fileName: string;
//   sourceCode: string;
//   summary: string;
//   score?: number;
// }

interface FileReference {
  fileName : String;
  sourceCode : String;
  summary : String;
  score?:number;
}


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

// Initialize Pinecone and Gemini
const pinecone = getPineconeClient();

// Configuration
const TOP_K = 5;
// Cosine scores for short/generic queries are often < 0.7; keep a lower floor
const SCORE_THRESHOLD = 0.15;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

// In-memory cache for query embeddings
const queryEmbeddingCache = new Map<string, number[]>();

// Utility to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Interface for search results
interface SearchResult {
  fileName: string;
  sourceCode: string;
  summary: string;
  score: number;
}


/**
 * Searches Pinecone for embeddings with retry logic and caching
 */
async function searchEmbeddings(query: string, namespace: string): Promise<SearchResult[]> {
  const pineconeIndex = pinecone.index("gitbuddy");
  const ns = pineconeIndex.namespace(namespace);

  // Check cache for query embedding
  let queryEmbedding = queryEmbeddingCache.get(query);
  if (!queryEmbedding) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        queryEmbedding = await generateEmbedding(query);
        queryEmbeddingCache.set(query, queryEmbedding);
        break;
      } catch (error: any) {
        if (error.response?.status === 429 || error.message.includes("rate limit")) {
          if (attempt === MAX_RETRIES) {
            console.error(`Failed to generate query embedding after ${MAX_RETRIES} attempts:`, error);
            throw error;
          }
          const retryDelay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`Rate limit hit for query embedding. Retrying after ${retryDelay}ms...`);
          await delay(retryDelay);
        } else {
          console.error("Error generating query embedding:", error);
          throw error;
        }
      }
    }
  }

  try {
    const queryResult = await ns.query({
      vector: queryEmbedding!,
      topK: TOP_K,
      includeMetadata: true,
    });

    const rawMatches = queryResult.matches || [];
    console.log(
      `Pinecone raw matches for ns=${namespace}:`,
      rawMatches.map((m) => ({ id: m.id, score: m.score, file: m.metadata?.fileName }))
    );

    return rawMatches
      .filter((match) => typeof match.score === "number" && match.score > SCORE_THRESHOLD)
      .map((match) => ({
        fileName: match.metadata?.fileName as string,
        sourceCode: match.metadata?.sourceCode as string,
        summary: match.metadata?.summary as string,
        score: match.score ?? 0,
      }));
  } catch (error) {
    console.error(`Error querying Pinecone namespace ${namespace}:`, error);
    throw error;
  }
}

/**
 * Normalizes scores to a 0-1 range
 */
function normalizeResults(results: SearchResult[]): SearchResult[] {
  const maxScore = Math.max(...results.map((r) => r.score), 1); // Avoid division by zero
  return results.map((r) => ({ ...r, score: r.score / maxScore }));
}

/**
 * Retrieves unique, sorted vector results
 */
async function retrieveVectorResults(query: string, namespace: string): Promise<SearchResult[]> {
  const vectorResults = await searchEmbeddings(query, namespace);
  const normalizedResults = normalizeResults(vectorResults);
  console.log(
    "normalizedResults",
    normalizedResults.map((r) => ({ file: r.fileName, score: Number(r.score.toFixed(3)) }))
  );
  const sortedResults = normalizedResults.sort((a, b) => b.score - a.score);
  const uniqueResults: { [key: string]: SearchResult } = {};

  for (const result of sortedResults) {
    if (result.fileName?.trim() && !uniqueResults[result.fileName]) {
      uniqueResults[result.fileName] = result;
      if (Object.keys(uniqueResults).length === TOP_K) break;
    }
  }

  return Object.values(uniqueResults);
}

// /**
//  * Enhanced askQuestion function with Pinecone retrieval
//  */
const ANSWER_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"] as const;
const MODEL_TIMEOUT_MS = 25000;

function isFallbackSummary(summary: string | undefined) {
  return /could not be determined due to an error/i.test(summary || "");
}

async function generateAnswer(prompt: string): Promise<string> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  let lastError: unknown = null;
  for (const modelName of ANSWER_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { maxOutputTokens: 2048, temperature: 0.2 },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${modelName} timed out after ${MODEL_TIMEOUT_MS / 1000}s`)),
          MODEL_TIMEOUT_MS
        );
      });
      try {
        const response = await Promise.race([model.generateContent(prompt), timeout]);
        const text = response.response.text().trim();
        if (text) {
          console.log(`Answer generated with ${modelName} (${text.length} chars)`);
          return text;
        }
        console.warn(`Model ${modelName} returned empty text`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
      console.error(
        `Model ${modelName} failed:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Every Gemini model returned an empty answer");
}

function friendlyError(error: unknown) {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "P1001" || code === "P1002" || code === "P2024" || /Can't reach database server/i.test(message)) {
    return "The database is waking up or unreachable right now. Wait a few seconds and send your question again.";
  }
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return "A network request failed while answering. Check your internet connection and try again.";
  }
  return "Something went wrong while answering. Please try again.";
}

export async function askQuestion(question: string, projectId: string) {
  try {
    return await answerQuestion(question, projectId);
  } catch (error) {
    console.error(`askQuestion failed for project ${projectId}:`, error);
    const stream = createStreamableValue();
    stream.update(friendlyError(error));
    stream.done();
    return { output: stream.value, filesReferences: [] as SearchResult[] };
  }
}

async function answerQuestion(question: string, projectId: string) {
  console.log("Asking question:", question);
  console.log("For project:", projectId);

  const stream = createStreamableValue();

  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) {
    stream.update("Please sign in again, then retry your question.");
    stream.done();
    return { output: stream.value, filesReferences: [] };
  }

  const membership = await prisma.userToProject.findUnique({
    where: { userId_projectId: { userId, projectId } },
    select: { id: true },
  });
  if (!membership) {
    stream.update("You don't have access to this project.");
    stream.done();
    return { output: stream.value, filesReferences: [] };
  }

  // Check project status
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { githubUrl: true, indexingStatus: true },
  });

  if (!project?.githubUrl) {
    stream.update("Error: Project has no GitHub URL.");
    stream.done();
    return { output: stream.value, filesReferences: [] };
  }

  if (project.indexingStatus !== "COMPLETED") {
    stream.update(
      project.indexingStatus === "INDEXING"
        ? "This repo is still being indexed. Give it a minute, then ask again."
        : "This repo isn't indexed yet. Press Reindex at the top of this page, then ask again."
    );
    stream.done();
    return { output: stream.value, filesReferences: [] };
  }

  // Retrieve vector results
  let filesReferences: SearchResult[];
  try {
    filesReferences = await retrieveVectorResults(question, projectId);
  } catch (error) {
    console.error(`Error retrieving vector results for project ${projectId}:`, error);
    stream.update("I couldn't search this repo's index just now. Try again, or press Reindex if it keeps failing.");
    stream.done();
    return { output: stream.value, filesReferences: [] };
  }
  console.log(
    "filesReferences",
    filesReferences.map((f) => ({
      file: f.fileName,
      score: Number(f.score.toFixed(3)),
      fallbackSummary: isFallbackSummary(f.summary),
    }))
  );

  if (filesReferences.length === 0) {
    // Fallback to GitHub API if a specific file is mentioned
    const filePathMatch = question.match(/\(([^)]+)\)/);
    const specificFilePath = filePathMatch ? filePathMatch[1] : null;

    if (specificFilePath) {
      try {
        const [owner, repo] = project.githubUrl.split("/").slice(-2);
        const fileResponse = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: specificFilePath,
        });

        if ("content" in fileResponse.data) {
          const fileContent = Buffer.from(fileResponse.data.content, "base64").toString("utf-8");
          filesReferences = [
            {
              fileName: specificFilePath,
              sourceCode: fileContent,
              summary: `The file ${specificFilePath} was retrieved directly from GitHub. No summary available from Pinecone.`,
              score: 1.0,
            },
          ];
        } else {
          stream.update(`Error: The file ${specificFilePath} could not be found in the repository.`);
          stream.done();
          return { output: stream.value, filesReferences: [] };
        }
      } catch (error) {
        console.error(`Error fetching file ${specificFilePath} from GitHub:`, error);
        stream.update(`Error: Unable to fetch the file ${specificFilePath} from GitHub. Please check the file path and try again.`);
        stream.done();
        return { output: stream.value, filesReferences: [] };
      }
    } else {
      stream.update("No relevant information found in the repository.");
      stream.done();
      return { output: stream.value, filesReferences: [] };
    }
  }

  const weakIndex = filesReferences.every((doc) => isFallbackSummary(doc.summary));

  // Build context from real code. Indexing often stored an error template as the "summary".
  let context = "";
  for (const doc of filesReferences) {
    const fallback = isFallbackSummary(doc.summary);
    const codeLimit = fallback ? 6000 : 2500;
    context += `
      ### File: ${doc.fileName}
      #### Summary:
      ${fallback ? "Summary unavailable. Answer from the code excerpt." : doc.summary}

      #### Code Content:
      \`\`\`
      ${(doc.sourceCode || "").slice(0, codeLimit)}
      \`\`\`
      \n\n`;
  }

  const answerPrompt = `
You are GitBuddy, an AI assistant that helps developers understand GitHub repositories.
Answer clearly in Markdown using ONLY the context below. Ignore summaries that say the purpose could not be determined, and use the code excerpts instead. If the context is weak, still give the best grounded answer you can and say what is uncertain. Keep the answer under 400 words.

START CONTEXT BLOCK
${context}
END OF CONTEXT BLOCK

START QUESTION
${question}
END OF QUESTION
`;

  // Generate with a hard timeout, then push the finished answer.
  // streamText on gemini-3.5-flash was leaving this stream open (no tokens, no .done()).
  (async () => {
    try {
      const answer = await generateAnswer(answerPrompt);
      const note = weakIndex
        ? "\n\n---\n_The search index for this repo is missing real file summaries, so this answer is based on the closest code excerpts. Use Reindex on this page, then ask again for a sharper result._"
        : "";
      stream.update(answer + note);
    } catch (error) {
      console.error(`Answer failed for project ${projectId}:`, error);
      const raw = error instanceof Error ? error.message : "";
      const message = /quota|429|rate/i.test(raw)
        ? "The AI model is rate-limited right now. Wait a moment and try again."
        : /timed out/i.test(raw)
          ? "The AI model took too long to respond. Please try again."
          : /API key|403|401|GEMINI_API_KEY/i.test(raw)
            ? "The Gemini API key is missing or invalid. Check GEMINI_API_KEY in .env.local."
            : "I found the relevant files but couldn't generate an answer. Please try again.";
      stream.update(message);
    } finally {
      stream.done();
    }
  })();

  return { output: stream.value, filesReferences };
}