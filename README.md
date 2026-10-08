# GitSaathi

**AI-powered GitHub companion for codebase Q&A, commit understanding, meeting intelligence, and repo analytics.**

GitSaathi (Hindi for *Git Companion*) turns a GitHub repository into a collaborative workspace where teams can ask natural-language questions about code, review AI-summarized commits, upload meeting audio for action-item extraction, and inspect repo health — all in one place.

---

## Table of Contents

- [Features](#features)
- [How each feature works (for testing)](#how-each-feature-works-for-testing)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Scripts](#scripts)
- [Architecture Overview](#architecture-overview)
- [Credits System](#credits-system)

---

## Features

| Feature | Route | Purpose |
|---|---|---|
| **Create Project** | `/create` | Link a GitHub repo, index it into Pinecone, deduct credits |
| **Ask me (Q&A)** | `/project/[id]/qa` | Chat with the codebase using RAG + Gemini |
| **Commits** | `/project/[id]/dashboard` | Poll GitHub commits and show AI summaries of diffs |
| **Meetings** | `/project/[id]/meetings` | Upload standup/meeting audio → transcript + action items |
| **Analytics** | `/project/[id]/analytics` | Contributors, commits/day, key commits, repo insights |
| **PR and Issues** | `/project/[id]/prAndissue` | Live pull requests and issues from GitHub |
| **Billing** | `/billing` | View / manage indexing credits |
| **Join Project** | `/join/[projectId]` | Collaborate on an existing project via invite |

---

## How each feature works (for testing)

### 1. Ask me (Q&A)

**Purpose:** Answer questions about the linked repository using vector search over indexed source files.

**Flow:**
1. On create, files are embedded (`gemini-embedding-001`) and stored in a Pinecone namespace = `projectId`.
2. A question is embedded, similar chunks are retrieved, then Gemini streams an answer with file references.

**How to test:**
1. Open a project whose `indexingStatus` is `COMPLETED`.
2. Go to **Ask me**.
3. Ask: `What is this repository about?` or `Where is the hero component?`
4. Expect: streamed markdown answer + file reference chips with scores.

**If answers are empty / “no relevant information”:**
- Confirm indexing finished (`COMPLETED` and vectors exist in Pinecone).
- Reindex: `GET /api/reindex?projectId=<id>`

---

### 2. Commits (Dashboard)

**Purpose:** Make git history readable. Instead of cryptic messages alone, each new commit gets an AI summary of the actual diff.

**Flow:**
1. Dashboard loads → `pollCommits(projectId)` fetches recent commits via Octokit.
2. Unprocessed commits are filtered against the `Commit` table.
3. Each new commit’s patch/diff is summarized with Gemini and saved (`commitMessage`, `summary`, author, hash, date).
4. UI shows a timeline with author avatar, message, AI summary, and link to GitHub.

**How to test:**
1. Open **Commits** for a project with a public GitHub URL and valid `GITHUB_TOKEN`.
2. Wait for the first poll, or click **Refresh**.
3. Expect: commit cards with AI summaries (not just raw messages).
4. Push a new commit on GitHub → Refresh → new entry with a fresh summary.

**Needs:** `GITHUB_TOKEN`, `GEMINI_API_KEY`, linked `githubUrl` on the project.

---

### 3. Meetings

**Purpose:** Capture standup / sync call audio so discussion does not get lost. Audio is transcribed and split into chapter-style “issues” (gist, headline, summary, timestamps).

**Flow:**
1. Upload audio on **Meetings** → stored (Vercel Blob) → `Meeting` row created (`PROCESSING`).
2. `processMeeting` sends audio to AssemblyAI with `auto_chapters: true`.
3. Chapters become `Issue` rows; meeting status → `COMPLETED`.
4. Open a meeting to read headlines, time ranges, and summaries.

**How to test:**
1. Go to **Meetings** → upload a short `.mp3` / `.wav` / `.m4a` (a spoken standup works best).
2. Confirm the meeting appears as **PROCESSING**, then **COMPLETED**.
3. Open the meeting detail page and verify chapter gists / headlines / summaries.

**Needs:** `ASSEMBLYAI_API_KEY`, Vercel Blob token / upload config.

---

### 4. Analytics

**Purpose:** High-level repo health — commit volume over time, contributors, impactful commits, and related insights from GitHub.

**How to test:** Open **Analytics** on an indexed project with enough commit history. Charts and contributor cards should populate.

---

### 5. PR and Issues

**Purpose:** Surface open/closed pull requests and issues from the linked GitHub repo without leaving GitSaathi.

**How to test:** Open **PR and Issues**. Expect lists synced from GitHub for the project’s `owner/repo`.

---

### 6. Create / Invite / Billing

- **Create:** Connect username or paste a GitHub URL → credit check → index → redirect to Q&A.
- **Invite:** From dashboard, invite teammates; they join via `/join/[projectId]`.
- **Billing:** Inspect remaining credits (indexing cost ≈ file count).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router), React 19 |
| Auth | NextAuth.js (GitHub / Google) |
| Database | PostgreSQL + Prisma |
| Vector DB | Pinecone |
| LLM / Embeddings | Google Gemini (`gemini-3.8-flash`, `gemini-embedding-001`) |
| GitHub API | Octokit |
| Meeting transcription | AssemblyAI |
| UI | Tailwind CSS, Radix UI, Framer Motion |
| File storage | Vercel Blob (meeting audio) |

---

## Project Structure

```text
src/
  app/
    (protected)/          # create, projects, billing, join
    project/[projectId]/  # dashboard, qa, meetings, analytics, prAndissue
    api/                  # auth, reindex helpers
  components/             # commit-log, meetings-list, upload-audio, sidebars, UI
  lib/
    retrival.ts           # RAG Q&A
    githubLoader.ts       # repo load + embedding pipeline
    github.ts             # commit polling + summarization
    github-insights.ts    # analytics
    assembly.ts           # meeting transcription
    repoEmbedding.ts      # embedding generation
    pineconedb.ts         # Pinecone upsert / client
    query.ts              # project/commit server actions
prisma/
  schema.prisma           # User, Project, Commit, Meeting, Issue, ...
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Pinecone index named `gitbuddy` (dimension **768**)
- API keys listed below

### Install

```bash
npm install
npx prisma generate
npx prisma db push
```

### Run

```bash
npm run dev
```

App defaults to [http://localhost:3000](http://localhost:3000) (or the next free port, e.g. `3001`).

---

## Environment Variables

Create `.env.local` in the project root:

```env
DATABASE_URL=
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=

GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

GITHUB_TOKEN=
GEMINI_API_KEY=
PINECONE_API_KEY=

ASSEMBLYAI_API_KEY=
# Vercel Blob (for meeting audio uploads)
BLOB_READ_WRITE_TOKEN=
```

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Next.js (Turbopack) |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npx prisma studio` | Browse database |

**Helpers:**
- Reindex a project: `GET /api/reindex?projectId=<id>`
- Top up credits (dev): `GET /api/add-credits` (if enabled)

---

## Architecture Overview

```text
GitHub Repo
    │
    ├─► Indexing (githubLoader) ─► Embeddings ─► Pinecone namespace(projectId)
    │                                              │
    │                                              └─► Ask me (RAG + Gemini stream)
    │
    ├─► pollCommits ─► Gemini diff summary ─► Commit table ─► Dashboard
    │
    └─► Insights / PRs / Issues ─► Analytics & PR pages

Meeting audio ─► Vercel Blob ─► AssemblyAI chapters ─► Issue rows ─► Meetings UI
```

---

## Credits System

- New users start with **200** credits (Prisma default).
- Creating/indexing a project costs roughly **1 credit per file** counted in the repo.
- Q&A and commit summarization use Gemini separately (API quotas), not the same credit meter.

---

## License

Private / unpublished unless otherwise stated by the repository owner.
