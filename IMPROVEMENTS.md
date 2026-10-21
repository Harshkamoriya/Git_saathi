# GitSaathi — Improvements / Known Gaps

Things that exist today vs what I would do next. Useful for "what would you improve?" questions.
Grouped by feature. Each item: **Today** → **Better** → **Why**.

---

## TODO — indexing upgrade (to build later)

- [ ] **Real chunking at function/class level** — split each file by function/class (AST, or overlapping chunks as a fallback) instead of truncating at 15k chars. Details: section 6.
- [ ] **Multiple vectors per file** — one vector per chunk; IDs like `projectId_<path>_<chunkIndex>`; retrieval dedupes by file. Details: section 6.
- [ ] **Raw code out of Pinecone metadata** — keep only `fileName`, chunk range and a pointer in metadata; fetch the code from DB or GitHub when answering. Fixes the ~40KB metadata limit. Details: section 7.
- [ ] **Track failed files and show them in the UI** — store failed files/batches, mark the project `PARTIAL` instead of a false `COMPLETED`, add a "retry failed files" button. Details: section 7.
- [ ] **Clear the project namespace before reindex** — delete all vectors in `namespace(projectId)` (or diff and delete removed files) so deleted files don't leave stale vectors. Details: section 7 / 9.

---

## Open issues (left over from the Oct 21 fix pass)

Create project
- [ ] **Private repos + ownership check** — list repos with the logged-in user's GitHub OAuth token (`repo` scope, `GET /user/repos`) instead of the server token; today anyone can index any public repo by typing its owner's username.
- [ ] **Real indexing progress** — add `indexedFiles` / `totalFiles` columns to `Project` (schema migration), update them per batch, show a real percentage in `IndexingBanner`.
- [ ] **Move indexing to a job queue** — `after()` still runs inside the function's time limit on Vercel; large repos need Inngest / QStash / a worker.
- [ ] **Clear the Pinecone namespace before reindex** — deleted files leave stale vectors.

Projects list
- [ ] **Owner / roles column** — "owner" is currently the earliest `UserToProject` row; add `role` (OWNER / MEMBER) to `UserToProject` or `ownerId` to `Project`.
- [ ] **Restore archived projects** — archive is a soft delete (`deletedAt`) with no UI to view or restore archived projects.

Auth (do with the Login feature)
- [ ] **`/create`, `/projects`, `/billing`, `/join` load without a session** — add them to the middleware matcher and redirect in `(protected)/layout.tsx`; server actions already refuse, so this is a UX gate.

Ask me
- [ ] **Verify Gemini model IDs on the real key** — answers try `gemini-3.5-flash-lite` → `gemini-3.8-flash` → `gemini-3.6-flash`; not smoke-tested against the project's API key.
- [ ] **Stream tokens again** — answers are generated in one call and sent at once (streaming was hanging); bring back streaming with a timeout once the SDK path is reliable.
- [ ] **Shared rate limiter** — the 15 questions/min limit is in-memory per server instance; move it to Redis/Upstash for multi-instance deploys.
- [ ] **Chunk large files** — each file is one vector (summary + first 20KB); split big files into chunks so questions about the end of a file can match.
- [ ] **Hybrid search + reranking** — add keyword (BM25) search next to vectors and rerank the top candidates for better precision.
- [ ] **Eval set** — keep ~20 fixed questions per demo repo with expected files, and measure retrieval hit-rate before changing prompts/models.
- [ ] **Server-side chat history** — chats live in localStorage (per browser, 24h); store them in the DB to sync across devices and share with project members.

---

## 1. Auth / Login

- **Protected routes not consistent**
  - Today: middleware `matcher` mainly covers `/project/*`. `/create`, `/projects`, `/billing`, `/join` UI can open without login; only the server actions fail.
  - Better: add all of them to the middleware matcher, and also redirect in `(protected)/layout.tsx` when session is missing.
  - Why: one consistent auth wall for both UI and API.

- **Middleware only checks that the cookie exists**
  - Today: checks `next-auth.session-token` is present, doesn't verify it.
  - Better: verify the JWT (e.g. `getToken` from `next-auth/jwt` or `withAuth`).
  - Why: a fake or expired cookie shouldn't get past the gate.

- **Keep server-side checks as the final defense**
  - Server actions already call `getAuthSession()`. Keep that; middleware is only a UX gate.

- **Project membership not checked everywhere (IDOR risk)**
  - Today: `askQuestion(question, projectId)` trusts the `projectId` and doesn't check `UserToProject`.
  - Better: check membership on every project-scoped action (Q&A, commits, meetings, analytics, reindex).
  - Why: knowing a projectId shouldn't give access to another team's code.

- **Reindex route auth only in production**
  - Today: `/api/reindex` skips the session check in dev.
  - Better: always require auth + membership; keep a separate admin script for recovery.

---

## 2. Create Project — repo list

- **Only public repos, uses server token**
  - Today: `octokit.rest.repos.listForUser(username)` with the server `GITHUB_TOKEN`.
  - Better: use the logged-in user's GitHub OAuth token → `GET /user/repos` with `repo` scope.
  - Why: private repos show up too, and ownership is verified automatically.

- **No ownership check**
  - Today: anyone can type someone else's username and index their public repos.
  - Better: the OAuth-token approach above, or at least check the repo belongs to the logged-in GitHub account.

- **No pagination**
  - Today: `per_page: 100`, first page only.
  - Better: `octokit.paginate(...)`.

---

## 3. Create Project — credit check

- **File count is slow and makes many API calls**
  - Today: `getFileCount` calls `repos.getContent` for every folder recursively.
  - Better: one call with the Git Trees API (`git.getTree` with `recursive: true`).
  - Why: fewer calls, faster, less rate limiting.

- **Count doesn't match what gets indexed (overcharge)**
  - Today: counts every file, including lockfiles and images, but the loader ignores them.
  - Better: apply the same ignore rules when counting and when charging.

- **Race condition on credits**
  - Today: check, then create, then `decrement`, as separate steps. Two tabs at once could both pass the check.
  - Better: a Prisma transaction with a conditional update (`where: { credits: { gte: fileCount } }`).

- **Credits charged even if indexing fails**
  - Today: credits are deducted before indexing; on failure the project becomes `FAILED` but there's no refund.
  - Better: charge only for files actually indexed, or refund on failure.

---

## 4. Create Project — indexing runs inside the request

- **Sync indexing inside the create request**
  - Today: `CreateProject` awaits all of `RepoGenerateEmbeddings` inside one server action.
  - Better: create the project and return right away; push indexing to a background job (Inngest / QStash / BullMQ worker); UI polls `indexingStatus`.
  - Why: Vercel function timeouts (~10s hobby / ~60s default pro) kill long indexing → status stuck at `INDEXING`, partial vectors in Pinecone.

- **Fake progress bar**
  - Today: 10 × 500ms animation on the create page, not real progress.
  - Better: the job writes `processedFiles / totalFiles` to the DB; the UI shows the real percentage.

- **Branch hardcoded to `main`**
  - Today: `GithubRepoLoader(..., { branch: "main" })`.
  - Better: read the repo's `default_branch` from the GitHub API (repos using `master` or other branches break today).

---

## 4b. Projects list (`/projects`)

- **Over-fetching for counts**
  - Today: `GetAllProjects` includes every commit, meeting and user row of every project just to show `.length`.
  - Better: Prisma `_count: { select: { commits: true, meetings: true, users: true } }`.
  - Why: list page gets slow as commits grow.

- **Soft-deleted projects still show**
  - Today: schema has `deletedAt`, but the query doesn't filter it.
  - Better: `where: { userId, project: { deletedAt: null } }`.

- **Status badge is wrong**
  - Today: yellow only for `PENDING`; `INDEXING` and `FAILED` show green like success.
  - Better: separate colors for PENDING / INDEXING / COMPLETED / FAILED, plus a "Reindex" action on FAILED.

- **"Contributors" label is misleading**
  - Today: counts GitSaathi members (`users`), not GitHub contributors.
  - Better: rename to "Members", or show real GitHub contributors.

- **Data fetching**
  - Today: client `useEffect` + local state.
  - Better: React Query (already in the stack) or a server component, for caching and refetch.

- **`prisma.$disconnect()` in `finally`**
  - Today: some queries (e.g. `GetProjects`, `getCommit`) disconnect Prisma after every call.
  - Better: use a shared singleton client and never disconnect per request (it hurts connection reuse in serverless).

---

## 4c. Ask Me (Q&A)

- **No auth / membership check (IDOR)**
  - Today: `askQuestion(question, projectId)` never calls `getAuthSession()`; anyone who knows a projectId can query that project's code.
  - Better: check session + `UserToProject` membership before retrieval.

- **No conversation memory**
  - Today: history is only in browser `localStorage` (2h expiry); the server gets just the latest question. Follow-ups like "and where is it called?" lose context.
  - Better: send last N turns, or rewrite the follow-up into a standalone query before embedding; store chats in DB so teammates/devices can see them.

- **Retrieval quality**
  - Today: pure vector search, `topK: 5`, threshold `0.15`, one vector per file.
  - Better: hybrid search (vector + keyword/BM25 for exact function names), a reranker, higher topK then rerank down, chunk-level vectors (see TODO at top).

- **Score "normalization" is a no-op**
  - Today: `Math.max(...scores, 1)` is always 1 for cosine scores, so dividing changes nothing.
  - Better: remove it, or normalize by the real max if relative scores are needed.

- **Dedupe by fileName is redundant today**
  - It only matters once there are multiple chunks per file — keep it for the chunking upgrade.

- **Only 2000 chars of code per file in the prompt**
  - Today: `sourceCode.slice(0, 2000)` — most of a big file never reaches the model.
  - Better: send the matched chunks instead of the file head (comes with chunking).

- **Full source code sent to the browser**
  - Today: `filesReferences` returns the full `sourceCode` of up to 5 files to the client.
  - Better: send file name + snippet; load full code lazily when the panel opens.

- **Prompt injection from repo content**
  - Today: retrieved code goes straight into the prompt; a file could contain "ignore previous instructions…".
  - Better: clear delimiters, tell the model context is untrusted data, never give the answer step tool access.

- **No evaluation**
  - Better: a small eval set (question → expected files) to measure retrieval hit-rate when changing topK, threshold, chunking or models.

- **Streaming model fallback**
  - Today: falls back to the next model on error or empty text; if a model dies mid-stream, the next one restarts the answer from scratch.
  - Fine for now; log which model answered + latency for monitoring.

---

## 4e. Commits (dashboard)

- **Commits silently skipped**
  - Today: `listCommits({ per_page: 10, since })`, only page 1. If 25 commits land between polls, only the newest 10 are saved; next poll's `since` = newest date, so the other 15 are never fetched.
  - Better: paginate (`octokit.paginate`) from `since` until caught up (with a cap), or webhooks.

- **"Polling" is only on page load / Refresh**
  - Today: summaries are generated inside the user's dashboard request (batch 2, 2s delay) → slow first load, timeout risk.
  - Better: GitHub `push` webhook (or a cron) → queue → summarize in background; dashboard just reads DB.

- **Duplicate commits possible**
  - Today: no unique constraint on `(projectId, commitHash)` (only an index); two tabs / double Refresh can both insert.
  - Better: `@@unique([projectId, commitHash])` + `createMany({ skipDuplicates: true })`.

- **Failed summaries saved forever**
  - Today: error strings like "Rate limit reached, retry later" are stored as the summary; since the hash now exists, it's never retried.
  - Better: `summaryStatus` column (PENDING / DONE / FAILED) and a retry job for FAILED.

- **No auth on commit actions**
  - Today: `pollCommits` and `getCommits` don't check session or membership.
  - Better: same membership check as other project actions.

- **Only default branch, author date**
  - Today: `listCommits` without `sha` = default branch; ordering uses author date (rebases can reorder).
  - Fine for now; note it.

---

## 4f. Meetings

- **Upload size limits don't match**
  - Today: UI allows up to 4MB but the error toast says "50MB"; the file goes through a server action, and Next's default server-action body limit is 1MB (`next.config.ts` doesn't raise it) → files over ~1MB can fail.
  - Better: client-side direct upload with `@vercel/blob/client` `upload()` + a token route (browser → Blob, server never touches the bytes); then allow large files (AssemblyAI handles long audio).

- **Fire-and-forget processing on serverless**
  - Today: `createMeeting` calls `processMeeting()` without awaiting; on Vercel the function can be frozen/killed after the response → meeting stuck in `PROCESSING`. Works locally.
  - Better: AssemblyAI `webhook_url` → `/api/assembly-webhook` saves chapters when ready; or Next `after()` / a queue job.

- **No FAILED status**
  - Today: on error the catch sets status back to `PROCESSING` (enum has only PROCESSING / COMPLETED) → stuck forever, user never knows.
  - Better: add `FAILED` + error message; show a "Retry" button.

- **Full transcript not saved**
  - Today: `transcript.text` is returned but never stored; only chapters go to DB.
  - Better: store the transcript (DB or Blob) → enables search, "ask the meeting" (index transcript in Pinecone alongside code).

- **Public audio URLs**
  - Today: `put(..., { access: "public" })` → anyone with the URL can play the meeting.
  - Better: private storage + short-lived signed URLs (one for AssemblyAI, one for playback).

- **Delete leaves the audio file**
  - Today: `deleteMeeting` deletes the DB row (issues cascade) but not the Blob.
  - Better: `del(meeting.meetingUrl)` from `@vercel/blob` too.

- **No auth on meeting actions**
  - Today: `createMeeting`, `fetchMeetings`, `fetchMeetingById`, `deleteMeeting` don't check session/membership (anyone with an ID can read or delete).
  - Better: membership check in each.

- **No live status**
  - Today: server-component pages; user must reload to see COMPLETED. Progress bar is simulated.
  - Better: poll status with React Query `refetchInterval` while PROCESSING (or SSE).

- **"Action items" wording**
  - Today: "issues" are AssemblyAI chapter summaries, not real action items/owners.
  - Better: run an LLM over the transcript to extract action items (task, owner, deadline) — optionally create GitHub issues from them.

---

## 4g. Analytics

- **Too many GitHub API calls, no cache**
  - Today: every page load paginates all commits, then up to 50 `getCommit` calls per author (sequential per author) + 10 more for key commits + issues/PRs/branches/tree. A 1000-commit, 10-author repo ≈ 500+ calls → tens of seconds, burns the 5000/hr limit.
  - Better: cache results in DB/Redis with a TTL (e.g. 1h) or refresh via background job/webhook; use GitHub's `stats/contributors` endpoint (per-author weekly additions/deletions in one call) instead of per-commit `getCommit`.

- **Code frequency 202 not handled**
  - Today: GitHub stats endpoints return 202 while computing → empty array → empty chart on first visit.
  - Better: retry after a few seconds when status is 202.

- **Contributors grouped by git author name**
  - Today: same person with different git names/emails is split; lines counted only from first 50 commits per author but shown like totals.
  - Better: group by GitHub `author.login` (fallback email); use stats/contributors for real totals.

- **Misleading metrics**
  - "Avg PR review time" = open → closed (includes unmerged); rename to "PR cycle time" or compute merged-only / first-review time.
  - `impactScore` weights are arbitrary (message length counts); only picks from the latest 10 commits. Explain it as a heuristic, or base it on lines/files across a time window.

- **No AI in "insights"**
  - Option: LLM summary of repo health ("activity dropped 40% this month, 3 PRs stale >14 days").

## 4h. PR & Issues

- **Fetches everything at once**
  - Today: paginates all PRs and issues (state all) on every visit; filter/sort client-side.
  - Better: server-side pagination + filter (`state`, `page`), or GitHub search API; cache.

- **Merged vs closed not separated**
  - Today: merged PRs show as `closed`.
  - Better: use `merged_at` → states Open / Merged / Closed.

- **Read-only**
  - Option: link out per item, comment/close actions with the user's own OAuth token; AI summary of a PR (diff → summary, reusing the commit prompt).

- **Duplicate logic**
  - `getRepoStatus` and `PRandIssues` both fetch issues/PRs and compute the same averages → extract shared helpers.

- **No auth check** on `getRepoStatus` / `PRandIssues` (same membership fix as other project actions).

---

## 4i. Billing / Credits

- **Billing page is static**
  - Today: hardcoded `demoPlans` pricing cards; no payment provider; doesn't show the user's credits.
  - Better: show current credits + usage history; Stripe/Razorpay checkout → webhook → increment credits in a transaction.

- **No way to top up**
  - Today: credits start at 200 and only go down; README's `/api/add-credits` doesn't exist.
  - Better: purchase flow (above), or an admin-only grant route.

- **Only indexing costs credits**
  - Q&A, commit summaries, meetings and reindex all call paid APIs but are free and unlimited → add per-feature metering or rate limits per user.

## 4j. Join Project (invites)

- **Invite = projectId**
  - Today: `{origin}/join/{projectId}`; no expiry, no revoke, no owner approval; projectId appears in every project URL, so anyone who sees one can join.
  - Better: `Invite` table with random token, expiry, max uses, created-by; join validates the token, not the projectId.

- **No roles**
  - Today: all members equal; nobody can remove a member.
  - Better: `role` on `UserToProject` (OWNER / MEMBER); only OWNER can invite, remove, delete, reindex.

- **Wrong login redirect**
  - Today: join page redirects unauthenticated users to `/auth/signin`, but the app's sign-in page is `/login` → 404.
  - Better: `signIn(undefined, { callbackUrl: "/join/<id>" })` so they come back to the invite after login.

## 4k. Reindex

- **Never sets COMPLETED**
  - Today: `/api/reindex` and `scripts/reindex-project.ts` set `INDEXING` → run embeddings → return, but never update to `COMPLETED` → project stays `INDEXING` and Ask Me refuses to answer.
  - Better: set `COMPLETED` after `RepoGenerateEmbeddings` succeeds (move status handling into one shared `runIndexing(projectId)` used by create + reindex).

- **No UI button**
  - Today: only a manual URL or CLI script, though the create error message says "reindex from Ask me".
  - Better: "Reindex" button on FAILED/stale projects (owner only).

- **GET for a state-changing action**
  - Today: `GET /api/reindex` triggers expensive work → link prefetch or a CSRF image tag could fire it.
  - Better: `POST` + CSRF-safe call.

- **Weak auth**
  - Today: no auth in dev; in prod any logged-in user can reindex any project (burns API quota).
  - Better: require membership (OWNER role); rate limit per project.

- Also: sync request (timeout), no credit charge, doesn't clear the namespace (see TODO at top).

---

## 4d. Prompts

- **Duplicated prompts**
  - Today: file-summary prompt copied in `gemini.ts` + `gemini2.ts`; commit-diff prompt copied in both too (only chunk size differs: 15k vs 9k).
  - Better: one `prompts/` module with named, versioned prompts (`FILE_SUMMARY_V1`, `COMMIT_SUMMARY_V1`, `RAG_ANSWER_V1`); log the version with each output.

- **No system/user separation**
  - Today: instructions + data go in one user message.
  - Better: instructions as `systemInstruction`, repo code / diff / question as user content → stronger against prompt injection.

- **Generation settings not set**
  - Better: low temperature for summaries (consistent output), explicit `maxOutputTokens`.

- **Commit chunk loop bug**
  - Today: `for (let i = 0; i < 30000; i += CHUNK_SIZE)` always makes 2 chunks (15k) or 4 chunks (9k), even for a tiny diff → empty chunks are sent to Gemini (wasted calls, junk "Part 2: …"), and anything after 30k chars is dropped.
  - Better: loop to `Math.min(diff.length, LIMIT)` and skip empty chunks; for big diffs do a proper reduce step (summarize the part-summaries into one line).

- **No prompt evals**
  - Better: a few golden files/diffs/questions; compare outputs when changing a prompt or model.

---

## 5. Indexing pipeline — ingest

- **GithubRepoLoader is a convenience choice**
  - Better at scale: download a tarball/zipball, or use Trees + Blobs API, and own the ignore rules.
  - Why: fewer round-trips, more control, works better in serverless.

---

## 6. Indexing pipeline — large files

- **Truncation instead of chunking**
  - Today: file content cut at 15,000 chars before summarizing; embedding input cut at ~9000 bytes. The bottom of big files is lost.
  - Better: split by function/class (AST) or overlapping chunks → summary per chunk → one vector per chunk (several vectors per file), optionally a file-level reduce summary.
  - Tradeoff: more LLM calls = more cost.

---

## 7. Indexing pipeline — concurrency, retries, model routing

- **Manual batching (size 4 + 1s delay)**
  - Today: heuristic, not load-tested. Per-batch `Promise.all`, no global cap.
  - Better: `p-limit` / token-bucket rate limiter tuned to the real RPM/TPM limits; adaptive slow-down on 429.

- **Backoff without jitter**
  - Today: `base * 2^(attempt-1)` (1s, 2s, 4s).
  - Better: add jitter (e.g. full jitter `random(0, delay)`).
  - Why: avoids parallel retries all hitting the API at the same moment (thundering herd).

- **429 vs 5xx inconsistent**
  - Today: indexing path retries only on 429 / "rate limit"; 5xx fails right away. The commit summarizer retries 5xx.
  - Better: one shared retry helper — retry 429 + 5xx + network errors, don't retry 400/401/403.

- **Dual summarizer = batch-parity round-robin, not failover**
  - Today: even batches → `summariseCode` (key 1), odd batches → `summariseCode_2` (key 2). On 429 it retries the same key. Embeddings always use key 1. The two functions are almost duplicate code.
  - Better: one summarizer + a config-driven provider pool `[{ key, model, weight }]` with failover on 429, plus per-provider metrics.

- **Failed files are skipped silently**
  - Today: a file that keeps failing returns `null` and is just not indexed.
  - Better: record failed files, show them in the UI, allow retrying only the failed ones.

- **Fallback summary gets embedded as a junk vector**
  - Today: if Gemini summarization fails after retries, `summariseCode` returns a generic "purpose could not be determined" text instead of throwing, and that text is embedded and upserted.
  - Better: throw / mark the file as failed; don't index placeholder text.
  - Why: junk vectors all look alike and pollute retrieval.

- **Pinecone metadata size limit**
  - Today: the full `sourceCode` is stored in Pinecone metadata. Pinecone allows ~40KB metadata per record, so big files can make the upsert fail.
  - Better: store code in Postgres / object storage (or GitHub) and keep only `fileName` + a pointer in metadata; fetch the code at answer time.

- **Batch upload failure is swallowed → false COMPLETED**
  - Today: if `uploadToPinecone` throws for a batch, it is only logged and the loop continues; the project still ends as `COMPLETED`.
  - Better: count failed batches/files; mark `PARTIAL` / `FAILED` and show it in the UI.

- **Stale vectors after reindex**
  - Today: IDs are `projectId_<path>`, so reindex overwrites changed files, but files deleted from the repo keep their old vectors.
  - Better: delete the namespace before a full reindex, or diff file lists and delete removed IDs.

- **`truncateText` cuts to ~2250 chars**
  - Today: in `repoEmbedding.ts`, text over 9000 bytes is cut with `substring(0, maxBytes / 4)` = 2250 characters, much less than intended.
  - Better: truncate by tokens (embedding model limit is 2048 tokens), not `bytes / 4`.

- **Embedding cache is mostly useless during indexing**
  - Today: in-memory caches keyed by file path / text; within one indexing run each file appears once, and the cache is lost on serverless restart.
  - Better: cache by content hash in DB/Redis → skip re-embedding unchanged files on reindex.

---

## 8. Scale & cost (e.g. 2,000-file repo)

- Default 200 credits means large repos can't be indexed without a top-up → need plans or bigger credit packs.
- Rough cost ~$5–10 in Gemini and ~1 hour → this only works as a background job, not inside a request.
- Track metrics: indexing time vs file count, cost per index, cost per question, retrieval quality.

---

## 9. Keeping the index fresh

- **Manual reindex only**
  - Better: GitHub webhook on push → incremental reindex of only the changed files (delete + upsert those vectors).
  - Why: the index goes stale as soon as the code changes.

---

## 10. Product focus

- Ask Me (RAG) has the most depth; commits and meetings are thinner integrations.
- Next priority: Ask Me quality + auto-reindex first, then deepen the other features.

---

## 11. Small cleanups

- README mentions `GET /api/add-credits`, but that route doesn't exist.
- Leftover names: npm package `rampage`, Pinecone index `gitbuddy` → rename or document.
- Duplicate UI under root `components/` and `src/components/`.
