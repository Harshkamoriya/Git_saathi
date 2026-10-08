"use server";

import {streamText } from 'ai'
import {createStreamableValue} from 'ai/rsc'
import{ createGoogleGenerativeAI} from '@ai-sdk/google'

import { getPineconeClient } from "@/lib/pineconedb";
import { prisma } from "@/lib/db";

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


const google = createGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

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
console.log("normalizedResults", normalizedResults);
  const sortedResults = normalizedResults.sort((a, b) => b.score - a.score);
  const uniqueResults: { [key: string]: SearchResult } = {};

  for (const result of sortedResults) {
    if (!uniqueResults[result.fileName] && result.fileName.trim()) {
      uniqueResults[result.fileName] = result;
      if (Object.keys(uniqueResults).length === TOP_K) break;
    }
  }

  return Object.values(uniqueResults);
}

// /**
//  * Enhanced askQuestion function with Pinecone retrieval
//  */
export async function askQuestion(question: string, projectId: string) {
  console.log("Asking question:", question);
  console.log("For project:", projectId);
  // console.log("process.env.GEMINI_API_KEY", process.env.GEMINI_API_KEY);

  const stream = createStreamableValue();

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
      `This project is not indexed yet (status: ${project.indexingStatus}). ` +
        `Embeddings must finish uploading to Pinecone before Q&A can work. ` +
        `Reindex via /api/reindex?projectId=${projectId} and try again.`
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
    stream.update("Unable to retrieve relevant files due to an error.");
    stream.done();
    return { output: stream.value, filesReferences: [] };
  }
  console.log("filesReferences", filesReferences);

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

  // Build context, leveraging the structured summaries
  let context = "";
  for (const doc of filesReferences) {
    context += `
      ### File: ${doc.fileName}
      #### Summary:
      ${doc.summary}

      #### Code Content:
      \`\`\`
      ${doc.sourceCode.slice(0, 2000)}
      \`\`\`
      \n\n`;
  }

  const answerPrompt = `
You are GitBuddy, an AI assistant that helps developers understand GitHub repositories.
Answer clearly in Markdown using ONLY the context below. If the context is weak, still give the best grounded answer you can and say what is uncertain.

START CONTEXT BLOCK
${context}
END OF CONTEXT BLOCK

START QUESTION
${question}
END OF QUESTION
`;

  // Prefer models that currently work on free/new API keys; fall back on quota/empty
  const modelCandidates = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-latest",
    "gemini-3.8-flash",
  ] as const;

  // Stream answer
  (async () => {
    let lastError: unknown = null;

    for (const modelName of modelCandidates) {
      try {
        let fullText = "";
        const { textStream, text } = await streamText({
          model: google(modelName),
          prompt: answerPrompt,
        });

        for await (const delta of textStream) {
          fullText += delta;
          stream.update(fullText);
        }

        // Some SDK/model combos leave the iterator empty; await final text
        if (!fullText.trim()) {
          const finalText = await text;
          if (finalText?.trim()) {
            fullText = finalText;
            stream.update(fullText);
          }
        }

        if (fullText.trim()) {
          stream.done();
          return;
        }

        console.warn(`Model ${modelName} returned empty text; trying next model…`);
      } catch (error) {
        lastError = error;
        console.error(`Model ${modelName} failed for project ${projectId}:`, error);
      }
    }

    const message =
      lastError instanceof Error
        ? `Unable to generate an answer: ${lastError.message}`
        : "I retrieved relevant files, but every Gemini model returned an empty answer. Check API quota/billing and try again.";
    stream.update(message);
    stream.done();
  })();

  return { output: stream.value, filesReferences };
}