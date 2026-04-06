# GitSaathi 🤖

GitSaathi (Hindi for "Git Companion") is a next-generation AI-powered GitHub assistant and context-aware project management hub. It transforms static repositories into interactive, queryable, and highly collaborative spaces tailored for agile development teams.

## 1. What is GitSaathi, Its Purpose, and The Problem It Solves

### What is GitSaathi?
GitSaathi is a full-stack Next.js application that tightly integrates with GitHub, Pinecone DB, and Google's Generative AI (Gemini) to act as an automated copilot for software teams. It provides chat-with-codebase capabilities, AI commit translations, and automated meeting issue extractions.

### Purpose
Its purpose is to **demystify complex codebases** and **streamline team synchronization**. Whether a developer is joining a legacy project, reviewing a massive PR, or catching up on a missed team standup, GitSaathi acts as an intelligent companion that can rapidly feed them the exact contextual knowledge they need to be productive.

### What Problem does it solve and How?
- **The Problem:** 
  1. *Slow Developer Onboarding:* New developers take weeks to understand module dependencies and system architecture in large repositories.
  2. *Cryptic Commits:* Commit messages are frequently vague, requiring reviewers to manually read raw git diffs to understand the conceptual changes.
  3. *Lost Meeting Context:* Action items discussed in Google Meets or Zoom calls are often easily lost or rely on manual documentation.
- **How it solves it:** 
  1. **RAG on Repositories:** It generates vector embeddings of the entire codebase and stores them in Pinecone. Developers can then type natural language queries to ask the AI where specific logic lives, and the AI answers by retrieving the exact code snippets.
  2. **Automated Summaries:** It utilizes Google Gemini to automatically translate massive raw `git diff` outputs into human-readable summaries.
  3. **Audio-to-Issues:** Using AssemblyAI, teams can upload their daily standup audio recordings. GitSaathi transcribes the meeting and uses AI to distill it into actionable structured "Issues / Gists" stored right alongside the project.

---

## 2. Tech Stack Used & Why

| Technology | Purpose | Why it was chosen |
|---|---|---|
| **Next.js 15 (App Router)** | Framework | Next.js offers unified frontend/backend architecture. Features like Server Actions remove the need for boilerplate API routes, and Server Components drastically improve initial load times and SEO. |
| **React 19 & Tailwind CSS** | UI / Styling | React provides dynamic UI states, while Tailwind's utility-first approach paired with Framer Motion and Radix UI components allows us to build a rich, animated, and accessible interactive interface rapidly. |
| **Prisma & PostgreSQL** | Database | Prisma provides the absolute best-in-class end-to-end type safety for database operations. It pairs perfectly with PostgreSQL, providing a scalable and strong relational schema structure. |
| **Google Generative AI (Gemini)** | Core LLM | Gemini offers immense context windows and powerful reasoning capabilities, making it ideal for deep code summarization and retrieval-augmented reasoning. |
| **Pinecone & Langchain** | Vector Search | RAG requires high-dimensional vector similarity search capabilities. Pinecone enables millisecond queries across thousands of embedded repository code chunks. Langchain easily structures the context injection pipeline. |
| **AssemblyAI** | Audio Processing | AssemblyAI holds leading accuracy for Speech-to-Text and speaker diarization, making it perfectly suited for transcribing messy team developer meetings. |
| **NextAuth.js & Octokit** | Auth & Git API | NextAuth provides plug-and-play secure social logins (GitHub). Octokit offers a rich, typed API client wrapper to fetch commits, PRs, and issues seamlessly from GitHub. |

---

## 3. API Endpoints & Functionality Classification

GitSaathi heavily utilizes **Next.js Server Actions** (`src/lib/...`) spanning across multiple dedicated modules instead of traditional REST APIs. Here is how they are classified based on functionally:

### Project Architecture & Management (`query.ts`, `githubLoader.ts`)
- `CreateProject`: Clones a GitHub repo, inspects the directory structure, deducts indexing credits, and initializes the Pinecone vectorization process.
- `GetProjects` / `GetAllProjects`: Fetches projects associated with the active user.
- `GetProjectById`: Retrieves detailed metadata for a single project dashboard.
- `JoinProject`: Connects a secondary user to an existing collaborative workspace.
- `allMembers`: Fetches all collaborators in the given project environment.
- `loadGithubRepo`: The core pipeline router to parse GitHub directories, filter text files, and prepare them for indexing.

### GitHub Interactivity & Aggregation (`github.ts`, `github-insights.ts`)
- `getCommitHashes` / `pollCommits`: Connects with the Octokit client to poll the remote repository for tracking incoming changes.
- `getCommit` / `getCommits`: Retrieves the already synced and stored database commit chunks for rapid frontend rendering.
- `summariseCommit` / `aiSummariseCommit`: Takes the raw string buffer of a `git diff`, passes it to the Gemini LLM, and persists a human-readable interpretation.
- `getRepoStatus` / `PRandIssues`: Analytics endpoints that extract pull requests, CI/CD statuses, and pending issues from the remote GitHub endpoint.

### AI RAG Pipeline & Code Queries (`repoEmbedding.ts`, `retrival.ts`, `pineconedb.ts`)
- `checkCreditsAndStructure`: Evaluates the user's remaining credit balance against the computed token size of the target repository before allowing indexing.
- `generateEmbeddings` / `RepoGenerateEmbeddings`: Converts string chunks of source code into floating-point multidimensional vector arrays.
- `uploadToPinecone`: Stores the vectorized documents into project-segregated namespaces in the Pinecone cloud.
- `askQuestion`: The core QA endpoint. Receives natural language questions, computes its vector, similarity-matches in Pinecone, injects the code chunks into the Gemini context window, and streams back the nuanced answer.

### Meeting Intelligence (`uploadToVercel.ts`, `assembly.ts`)
- `uploadAudio`: Proxies large audio blobs from the client directly into Vercel Blob cloud storage.
- `createMeeting`: Registers an audio URL tracking ticket into the Postgres database.
- `fetchMeetings` / `fetchMeetingById`: Retrieves meeting states (Processing vs Completed).
- `processMeeting`: A powerful async worker sequence that passes audio to AssemblyAI, gets the transcript back, prompts an LLM to find action items, and generates database `Issue` tokens.

---

## 4. Features and Facts of the Project

**Core Features List:**
- **Chat-with-Repo:** Interactive natural language UI that allows developers to ask architectural questions directly to the codebase.
- **Smart Commit Dashboard:** Replaces ambiguous git logs with contextual AI-summarized insights on what exactly changed in each PR/Commit.
- **Intelligent Meeting Transcription:** Enables developers to upload audio of standups, which the system automatically transcribes, summarizes, and extracts key actionable tasks/issues.
- **Integrated Markdown Previews:** The UI is heavily focused on displaying rich, colorful markdown, code snippets, Mermaid graphs, and markdown editors beautifully without leaving the app.
- **Project Analytics:** GitHub PRs, issues, and raw stats are fetched and presented on the GitSaathi dashboard.
- **Collaborative Workspaces:** Members can join projects and view universal project knowledge, commits, and meetings simultaneously.

**Key Facts:**
- The application implements an isolated **namespace architecture** in the Vector Database. Each project gets its isolated namespace so embedding similarities never cross-pollinate between different repositories.
- The platform uses a **Credit System**, initializing each new user with `200` credits, charging relative sizes for repository structural indexing.
- GitSaathi does away with explicit API routes, opting instead for heavy Server Actions mapped to asynchronous client calls.

---

## 5. Potential Improvements

- **Omni-Model Provider Setup:** Allow teams to dictate their preferred LLMs beyond Gemini via API key overrides (e.g., Anthropic Claude 3.5 Sonnet, OpenAI GPT-4o) specifically for the dense RAG QA.
- **Two-Way GitHub Syncing:** Provide a capability to push AssemblyAI generated "Issues" straight back into the real GitHub Issues tab of the remote repo automatically.
- **IDE Integrations:** Bundle the backend as an endpoint for a potential VSCode / JetBrains extension so developers can query GitSaathi directly from their local editor.
- **Real-time Subscriptions:** Migrate the commit polling architecture towards GitHub Webhooks coupled with WebSockets/Server-Sent Events for real-time dashboard reactivity without the need to refresh.
- **Granular RBAC:** Move from the flat "Member" model to granular roles (Admin, Contributor, Read-Only Observer) to protect sensitive features like meeting deletion or triggering project re-indexes.

---

## 6. Summary of the Project

**GitSaathi** represents a massive leap forward in developer-environment utilities. By unifying Vector Databases for instantaneous codebase querying, AssemblyAI for capturing elusive conversational context from meetings, and deep integration with GitHub’s data flow, GitSaathi becomes the "brain" for its users’ development lifespan. 

It successfully solves the pain points of code obfuscation, poor documentation, and un-tracked meeting dialogues. As an end product, it doesn't just offer an administration dashboard; it offers an active assistant that saves countless hours of developer onboarding and code reviewing, ultimately maximizing squad productivity and code comprehension.
