# GitSaathi — Interview Q&A

Practice notes. Prefer **feature workflows** over rote Q&A. Questions we practice still get saved below.

---

## How we use this file

1. Learn each feature’s end-to-end flow.
2. You ask a question; answer if you know; otherwise I answer.
3. We save the final clear answer here for revision.

---

## All features (product map)

| # | Feature | Route | One-line what it does |
|---|---|---|---|
| 1 | **Auth / Login** | `/login` | Sign in with GitHub or Google (NextAuth) |
| 2 | **Create Project** | `/create` | Link a GitHub repo → credit check → index into Pinecone |
| 3 | **Projects list** | `/projects` (protected) | See your projects / open one |
| 4 | **Ask me (Q&A)** | `/project/[id]/qa` | Chat with codebase (RAG + Gemini stream) |
| 5 | **Commits** | `/project/[id]/dashboard` | Poll GitHub commits + AI diff summaries |
| 6 | **Meetings** | `/project/[id]/meetings` | Upload audio → AssemblyAI transcript + action items |
| 7 | **Analytics** | `/project/[id]/analytics` | Contributors, commits/day, repo insights |
| 8 | **PR and Issues** | `/project/[id]/prAndissue` | Live PRs & issues from GitHub |
| 9 | **Billing / Credits** | `/billing` | See / manage indexing credits (start 200) |
| 10 | **Join Project** | `/join/[projectId]` | Join a project via invite (team collab) |
| 11 | **Reindex** | `GET /api/reindex?projectId=` | Re-run indexing if failed / stale |

Supporting (not separate “product features” but part of system): landing page `/`, soft-delete projects, invite from dashboard.

---

## Prompts used in the project

**3 unique prompts, 5 copies in code** (dual-key setup ki wajah se duplicate):

| # | Prompt | Where | Used by | Purpose |
|---|---|---|---|---|
| 1 | **File summary** | `gemini.ts` → `summariseCode` (key 1), `gemini2.ts` → `summariseCode_2` (key 2) | Indexing (`RepoGenerateEmbeddings`) | Har file ki structured Markdown summary → yahi embed hoti hai |
| 2 | **Commit diff summary** | `gemini.ts` → `aiSummariseCommit` (15k chunks), `gemini2.ts` → `aiSummariseCommit_2` (9k chunks) | Commits dashboard (`github.ts` → `summariseCommit` / `_2`) | Diff ka 1-line "kya badla, kyun" summary |
| 3 | **RAG answer** | `retrival.ts` → `answerPrompt` | Ask Me (`askQuestion`) | Retrieved files ke context se sawaal ka grounded answer, streamed |

**Prompt 1 — file summary:** role "expert senior software engineer", do goals (junior onboarding + embedding retrieval). Fixed sections: Overview / Key Components / Interactions / Dependencies / Key Takeaways — har section mein file name. Function/class names + library keywords daalne ko bolta hai (retrieval match ke liye), ≤500 words, edge cases (unclear/config file), metadata (paths, line numbers) mat daalo. Code 15k chars tak. Missing section → code placeholder add karta hai.

**Prompt 2 — commit diff:** role "expert programmer". Purpose/impact pe focus, 1–2 key files ho toh hi naam, `+`/`-`/context lines ka reminder, `diff --git`/`index` lines ignore, **few-shot examples** ("Added caching…", "Fixed validation bug… (src/auth.ts)"), "examples copy mat karo". Bade diff → chunks → "Part 1: … Part 2: …" join.

**Prompt 3 — RAG answer:** role "GitBuddy". Context block (per file: name, summary, code first 2000 chars) START/END delimiters ke andar, question alag block. "Answer in Markdown using ONLY the context… weak ho toh best grounded answer + uncertain kya hai bata."

**Prompt nahi, lekin AI:** embedding (sirf text → vector, koi instruction nahi); Meetings mein AssemblyAI `auto_chapters: true` — gist/headline/summary AssemblyAI ka model khud banata hai, humara prompt nahi.

**Techniques used:** role prompting, structured output sections, retrieval-oriented keyword stuffing, few-shot examples, format reminders, grounding ("ONLY context"), uncertainty admission, length cap, delimiters.
**Missing:** prompts ek central file/version mein nahi (copy-paste duplicates), system vs user role alag nahi (sab ek message), temperature set nahi, evals nahi.

---

## Feature workflows

### 1. Auth / Login — oral story (short)

Login OAuth hai — GitHub ya Google, NextAuth se. Password nahi.

**Short flow:**  
`/login` pe button → `signIn(github/google)` → provider pe allow → callback `/api/auth/[...nextauth]` → User + Account DB mein (PrismaAdapter, 200 credits) → JWT cookie → `/create`.  
Protected `/project/*` pe middleware cookie check; nahi toh wapas login. Server pe `getAuthSession()` se user id.

#### Q. Session JWT se kaise rehti hai? Middleware cookie kaise check karta hai? (simple)

**Analogy:** event ka wristband. Entry pe ek baar ID check (GitHub login), phir haath pe sealed wristband (cookie mein JWT). Har gate pe guard sirf wristband dekhta hai, register (DB) nahi kholta.

**Login ke baad:** NextAuth ek token banata hai jisme user ki info hai → `jwt` callback pehli baar (`user` object sirf login pe milta hai) `token.id = user.id` daalta hai → token **NEXTAUTH_SECRET se encrypt/sign** hota hai → browser mein **httpOnly cookie** `next-auth.session-token` (HTTPS pe `__Secure-next-auth.session-token`) mein save, default ~30 din.

**Har request pe:** browser cookie apne aap bhejta hai → server `getAuthSession()` (= `getServerSession(authOptions)`) cookie padhta, secret se decrypt/verify → `session` callback `session.user.id = token.id` → server action ko pata "yeh user X hai". **DB query nahi** — isliye fast. (Strategy JWT hai, toh Prisma `Session` table use hi nahi hoti; adapter sirf User/Account banata hai.)

**Middleware (`src/middleware.ts`):** request page tak pahunchne se pehle chalta hai → cookies parse → `next-auth.session-token` ya secure wala hai? → `/project/*` pe cookie nahi → `/login` redirect; hai → aage jaane do. **Sirf cookie ka hona check karta hai, verify nahi** — asli verification `getAuthSession()` server pe karta hai.

**JWT vs DB session:** JWT — fast, DB load nahi, serverless-friendly; nuksaan: logout/ban pe turant revoke mushkil (token expiry tak valid), token mein zyada data nahi daal sakte. DB session — har request DB hit, lekin turant revoke possible.

#### Q. Token "lock" kaise hota hai, aur kahan store hota hai?

**Lock:** NextAuth v4 by default JWT ko sirf sign nahi, **encrypt** karta hai (JWE, `A256GCM`). `NEXTAUTH_SECRET` se ek encryption key derive hoti hai (HKDF). Encrypt → andar ka data (user id, name, email, `exp`) koi padh nahi sakta. GCM ka **auth tag** → ek bhi character badla toh decrypt fail = tamper detect. Key sirf server ke paas (env variable), browser ke paas sirf locked dabba.
*(Normal signed JWT base64 mein readable hota hai, sirf tamper-proof; NextAuth ka default isse aage — unreadable bhi.)*

**Store:** browser **cookie** `next-auth.session-token` (HTTPS pe `__Secure-` prefix). Flags: `httpOnly` (JS `document.cookie` se padh nahi sakti → XSS se token chori mushkil), `Secure` (HTTPS only), `SameSite=Lax` (dusri sites se aane wali most requests pe nahi jaati → CSRF protection). Hum manually nahi bhejte — **browser har same-domain request pe khud attach karta hai**.

**Server pe har request:** cookie se token → secret se decrypt + tamper check + `exp` check → `session` callback `session.user.id = token.id` → server action use karta. **Session kahin save nahi hoti** — har request pe memory mein fresh banti, response ke saath khatam. Persistent cheez sirf cookie wala token hai.

**Expiry:** default `maxAge` 30 din; active use pe NextAuth cookie refresh karta (`updateAge` ~24h). Expire → decrypt/verify fail → logged out. Logout = cookie delete.

### 2. Create Project — oral story (short)

Page `/create`. Goal: GitHub repo ko GitSaathi project banana + Pinecone pe index.

**UI flow:** GitHub username → repos list (Octokit) → repo choose **ya** URL paste → credit check (file count vs credits) → project name → Create.

**Backend (`CreateProject`):** login check → dubara credit check → agar files > credits toh fail → Project DB (`INDEXING`) + UserToProject + credits kaato (≈1/file) → `RepoGenerateEmbeddings` (load → summarize → embed → Pinecone ns=projectId) → success pe `COMPLETED`, fail pe project reh jaata hai `FAILED` (reindex possible) → UI dashboard pe bhejti hai.

**Ek line:** repo choose → credits check → DB project → index vectors → ready for Ask me.

#### Q. Username daalne pe repos ki list kaise aati hai? Kaunsi technology?

Username daalte hi frontend server action `fetchUserRepos(username)` call karta hai (`githubLoader.ts`). Server pe **Octokit** (GitHub ka official JS SDK) GitHub REST API hit karta hai — `octokit.rest.repos.listForUser({ username, per_page: 100, sort: "updated" })`, matlab `GET /users/{username}/repos`. Auth server ke `GITHUB_TOKEN` se hota hai (rate limit 60/hr se ~5000/hr), user ke OAuth token se nahi. Response se name, fullName, description, private map karke UI ko list milti hai. Select karne pe `https://github.com/{fullName}` URL aage create flow mein jaata hai.

Fayde: simple, ek API call, login token ka scope handle nahi karna, kisi bhi public username ki repos dikh jaati hain. Nuksaan / gaps: sirf **public repos** aati hain (private nahi, kyunki user ka apna token use nahi ho raha); sirf pehli **100** (pagination nahi); kisi aur ka username daal ke uski public repos bhi index kar sakte ho — ownership verify nahi. Better: login ke GitHub OAuth token se `GET /user/repos` (`repo` scope) — apni private repos bhi + ownership automatically, plus pagination.

#### Q. Repo select karne ke baad aage kya hota hai?

Select pe project name auto-fill = repo name (`handleSelectRepo`). "Next" pe URL banta hai `https://github.com/{username}/{repo}` (ya pasted URL basic validate — `github.com` + 5 parts) → `checkCreditsAndStructure(githubUrl)` server action: session check → URL split se owner/repo → `getFileCount` recursive: Octokit `repos.getContent` har folder pe, files count, sub-folders `Promise.all` se parallel → Prisma se user credits → `{ fileCount, userCredits }`.

UI "configure" step: "This repository will use N credits", kam ho toh "Insufficient credits" + button disabled (`fileCount <= userCredits`). Name edit kar sakte ho → Create → progress bar (honestly fake: 10×500ms ≈ 5s animation, real progress nahi) → `CreateProject` server pe **dubara** credit check (client pe trust nahi) → Project INDEXING + membership + credits decrement → `RepoGenerateEmbeddings` → COMPLETED/FAILED → toast → `/project/{id}/dashboard`.

Gaps: file count sab files ginta hai (lockfiles/images bhi) jabki loader unko ignore karta hai → thoda overcharge; har folder = 1 API call → bade repo pe slow + rate limit; check aur create ke beech race (do tabs) — credit decrement atomic condition ke saath nahi; fake progress bar.

### 2b. Indexing pipeline — full deep flow (load → "chunk" → summarize → embed → save)

Entry: `CreateProject` (ya `/api/reindex`) → `RepoGenerateEmbeddings(projectId)` in `githubLoader.ts`.

**Step 1 — Load:** Prisma se `githubUrl` → `GithubRepoLoader` (branch `main`, recursive, ignore lockfiles/node_modules/dist/build/public/images…, `maxConcurrency: 3`, GitHub 403/rate-limit pe 3 retries exponential). Output: `Document[]` — har file = ek Document (`pageContent` = poora code, `metadata.source` = path).

**Step 2 — "Chunking":** Real chunking **nahi** hai. **1 file = 1 unit = 1 vector.** Sirf files ko **batches of 4** mein todte hain processing ke liye (chunking nahi, rate-limit control).

**Step 3 — Summarize (per file):** batch number even → `summariseCode` (key 1), odd → `summariseCode_2` (key 2). Code pehle 15,000 chars pe truncate. Prompt: "senior engineer, junior ko onboard karo + embedding ke liye", fixed sections (Overview / Key Components / Interactions / Dependencies / Key Takeaways), har section mein file name, function names/keywords, ≤500 words. Missing section ho toh placeholder append. Gemini fail (3 retries ke baad bhi) → **generic fallback summary** return hoti hai (throw nahi).

**Step 4 — Embed:** `generateEmbedding(summary)` — `gemini-embedding-001`, `outputDimensionality: 768`. Embed **summary** hota hai, raw code nahi. 9000-byte limit, 10s timeout, all-zero vector reject, 3 retries, in-memory cache.

**Step 5 — Record banana:** `{ id: projectId_<path sanitized>, values: 768 floats, metadata: { fileName, sourceCode (poora code), summary, projectId } }`.

**Step 6 — Save:** `uploadToPinecone(vectors, projectId)` → index `gitbuddy` → `namespace(projectId)` → metadata sanitize (sirf string/number/bool/string[]) → `upsert`. Batch ke baad 1s delay, next batch.

**Step 7 — Finish:** loop khatam → `CreateProject` status `COMPLETED` (exception aaye toh `FAILED`).

**Kyun summary embed:** user sawaal English mein poochta hai ("auth kahan hai?") — English summary ka vector un sawaalon ke zyada paas hota hai bajaye raw code ke. Metadata mein raw code rakha taaki answer time pe Gemini ko actual code mile.

**Tradeoffs / gaps:** bade file ka neeche wala hissa lose (15k truncate, 1 vector/file); fallback summary bhi embed ho jaati hai → junk vector; Pinecone metadata limit ~40KB/record — bada `sourceCode` upsert fail kara sakta hai, aur batch upload error sirf log hota hai → project phir bhi COMPLETED (silent partial index); reindex pe delete hui files ke purane vectors reh jaate hain; ID path se bana hai toh reindex same file overwrite karta hai (achha, idempotent).

### 3. Projects list — oral story (short)

Page `/projects` (client component). Mount pe `useEffect` → server action `GetAllProjects()` → session check (nahi toh `/login`) → Prisma `userToProject.findMany({ where: { userId }, orderBy: createdAt desc, include: { project: { include: commits, meetings, users } } })` → har row se `project` nikaal ke list.

UI: loading pe skeleton cards, error pe message, empty pe "Create your first project". Har card: name, `indexingStatus` badge, GitHub link (click propagation roka), created/updated date, Commits / Meetings / Contributors counts. Card click → `/project/{id}/dashboard`.

Membership-based hai: sirf woh projects jinme tum `UserToProject` se jude ho — khud banaye + join kiye dono.

**Gaps:** counts ke liye saare commits/meetings rows fetch (over-fetching, `_count` use karna chahiye); `deletedAt` filter nahi → soft-deleted projects bhi dikhte; badge sirf PENDING pe yellow, FAILED/INDEXING bhi green; "Contributors" asal mein GitSaathi members hain, GitHub contributors nahi; React Query ki jagah raw useEffect.

### 4. Ask Me (Q&A) — full flow

Page `/project/[id]/qa` (client) → server action `askQuestion(question, projectId)` in `src/lib/retrival.ts`.

**Client:** question type → messages mein push → `askQuestion` call → turant `{ output (streamable), filesReferences }` milta hai → `readStreamableValue(output)` loop — har update pe *poora* text aata hai (delta nahi) → live answer render (`MemoizedMarkdown`) → stream khatam → answer + references messages mein. File chips click → `CodeReferencePanel` (code syntax-highlighted + summary + score, copy button). History `localStorage` mein `chatMessages-{projectId}`, 2 ghante expiry. Server pe history nahi jaati → har sawaal independent (no conversation memory).

**Server — 1. Guards:** Prisma se project → githubUrl nahi → error; `indexingStatus !== COMPLETED` → "not indexed yet, reindex" message. (Auth/membership check **nahi**.)

**2. Retrieval (`retrieveVectorResults`):** question embed (`gemini-embedding-001`, 768, same as indexing — zaroori, same vector space) → in-memory query cache, 429 pe 3 retries exp backoff → Pinecone `gitbuddy` → `namespace(projectId)` → `query({ topK: 5, includeMetadata: true })` → score > **0.15** filter → "normalize" (max score se divide — par `Math.max(..., 1)` hamesha 1 → effectively no-op) → sort desc → fileName pe dedupe → max 5.

**3. Fallback:** 0 results + question mein path brackets mein, e.g. `(src/app/page.tsx)` → Octokit `getContent` se file seedha GitHub se, score 1.0. Warna "No relevant information found".

**4. Prompt:** har file: `### File`, summary, code `slice(0, 2000)`. System-style prompt: "You are GitBuddy… answer in Markdown using ONLY the context… say what is uncertain" + question.

**5. Generate + stream:** `createStreamableValue()` → async IIFE background mein chalti hai, function turant return → Vercel AI SDK `streamText` + `@ai-sdk/google` → `textStream` ke har delta pe `stream.update(fullText)`. Model fallback list: `gemini-3.5-flash` → `-lite` → `gemini-flash-latest` → `gemini-3.8-flash` — error ya empty text pe next. Sab fail → error message stream.

**Fayde (Ask Me):** grounded answers + file references (trust), streaming = fast perceived latency, namespace isolation, model fallback se resilience, path fallback se exact file sawaal.

### 5. Commits (dashboard) — full flow

Page `/project/[id]/dashboard` → `CommitLog` component (`src/components/commit-log.tsx`).

**Trigger:** "polling" naam hai lekin timer/webhook nahi. React Query `fetchCommits` = pehle `pollCommits(projectId)` phir `getCommits(projectId)`. Page load pe ek baar chalta hai (`staleTime` 30 min, focus/mount pe refetch off) + **Refresh** button pe dobara.

**`pollCommits` (src/lib/github.ts):**
1. Project se `githubUrl`.
2. DB mein is project ka latest saved commit → uski `commitDate` = `since`.
3. Octokit `repos.listCommits({ owner, repo, per_page: 10, since })` → hash, message, author name, avatar, date. 403/429 pe 3 retries exp backoff.
4. `filterUnprocessedCommits`: DB ke saare saved hashes Set mein → jo already hain unko hatao (`since` inclusive hai, isliye last wala dobara aata hai — yahin filter hota hai).
5. `batchSummariseCommits`: **batch 2**, batches ke beech **2s delay**, keys alternate (`summariseCommit_2` / `summariseCommit`), `Promise.allSettled` (ek fail ho toh baaki chalen; fail → "Summary unavailable").
6. Har commit: axios `GET /repos/{owner}/{repo}/commits/{sha}` with header `Accept: application/vnd.github.v3.diff` → **raw diff text** → commit-diff prompt (Gemini) → bade diff → chunks → "Part 1: …".
7. `prisma.commit.createMany` — projectId, hash, message, author, avatar, date, summary.

**Display:** `getCommits` → latest **10** by `commitDate desc` → timeline: avatar, author, time ago, message, AI summary (Markdown), GitHub link.

**Kyun:** commit messages aksar "fix", "wip" — diff padh ke AI batata hai asal mein kya badla. Summary DB mein cache → har baar Gemini nahi.

**Gaps:** sirf latest 10 per poll → 10+ naye commits aaye toh beech wale `since` ki wajah se **hamesha ke liye miss**; pehli baar sirf last 10 history; `(projectId, commitHash)` unique constraint nahi → do tabs/Refresh race pe duplicates; summaries user ke page load pe request ke andar bante → slow + timeout; failure text ("Rate limit reached…") DB mein save → kabhi retry nahi (hash already exists); empty-chunk prompt bug; `pollCommits`/`getCommits` pe auth/membership check nahi; sirf default branch.
**Better:** GitHub **push webhook** → queue → summarize; pagination with `since` until caught up; unique constraint + `skipDuplicates`; summary status (PENDING/DONE/FAILED) + retry.

### 6. Meetings — full flow

Page `/project/[id]/meetings` → `UploadAudio` + `MeetingsList`. Detail `/project/[id]/meetings/[meetingId]` → `IssuesList`.

**1. File choose (client, `upload-audio.tsx`):** drag-drop ya select. Checks: size ≤ **4MB**, type mp3 / wav / m4a. Progress bar **simulated** (random badhta, 95% pe ruk jaata).

**2. Upload (`uploadAudio`, server action, `uploadToVercel.ts`):** File server action ko jaata hai → `@vercel/blob` `put(file.name, file, { access: "public" })` → public Blob URL.

**3. Meeting row (`createMeeting`):** Prisma `Meeting` { name = file name, meetingUrl = blob URL, projectId, status `PROCESSING` } → `processMeeting(meeting.id)` **fire-and-forget** (await nahi, sirf `.catch` log) → meeting turant return → client `/meetings/{id}` pe navigate.

**4. Transcription (`processMeeting`, `assembly.ts`):** DB se URL → AssemblyAI SDK `client.transcripts.transcribe({ audio: url, auto_chapters: true })` — SDK job submit karke done hone tak poll karta hai. AssemblyAI khud URL se audio download karta hai.

**5. Chapters → Issues:** `transcript.chapters` — har chapter: start/end (ms → `mm:ss`), `gist` (2–3 words), `headline` (1 line), `summary` (paragraph). Ek hi `meeting.update` mein status `COMPLETED` + nested `issues.create` (har chapter = ek `Issue` row).

**6. View:** list pe status badge (PROCESSING/COMPLETED), issue count, delete. Detail page pe har issue: time range, headline, gist, summary. Pages server components hain — **auto-refresh nahi**, COMPLETED dekhne ke liye reload.

**"Issues" = AssemblyAI ke chapters**, GitHub issues nahi, aur strictly "action items" nahi — topic-wise summaries hain. Prompt humara nahi, AssemblyAI ka model.

**Kyun yeh stack:** Blob = audio ke liye simple hosted storage + URL (AssemblyAI ko URL chahiye); AssemblyAI = transcription + chapters ek flag se, apna Whisper/LLM pipeline nahi chalana.

**Gaps:** Next server action body limit default **1MB** aur `next.config` mein badhaya nahi → 1–4MB files fail ho sakti (UI 4MB allow karta, error message "50MB" bolta — mismatch); fire-and-forget serverless (Vercel) pe response ke baad function freeze/kill → meeting `PROCESSING` pe atak sakti; error pe bhi status `PROCESSING` set (FAILED enum nahi) → stuck forever; full transcript text DB mein save **nahi** (sirf chapters); Blob **public** → URL ho toh koi bhi audio sun sakta; delete pe Blob file delete nahi; `createMeeting` / `fetchMeetings` / `deleteMeeting` pe auth/membership nahi; auto-refresh nahi; fake progress.
**Better:** client-side direct upload (`@vercel/blob/client` `upload()` + token route) → body limit bypass; AssemblyAI `webhook_url` → callback route issues save kare (ya queue/`after()`); FAILED status + retry; transcript save; private blob/signed URLs; auth checks; status polling.

### 7. Analytics — full flow

Page `/project/[id]/analytics` → client `RepoInsights` (`analytics.tsx`) → `useEffect` → server action `getRepoStatus(projectId)` (`src/lib/github-insights.ts`). **Koi AI nahi, koi DB cache nahi** — har page load pe live GitHub API (server `GITHUB_TOKEN`).

**Steps:** project se `githubUrl` → `parseRepoUrl` (`.git` / trailing slash clean) → Octokit calls:
`repos.get` (name, description, stars, forks) · `paginate(listCommits)` (**saare** commits) · har unique author ke pehle ≤50 commits pe `getCommit` (lines added/deleted) · `getCodeFrequencyStats` (weekly additions/deletions) · `paginate(issues.listForRepo, state: all)` · `paginate(pulls.list, state: all)` · `paginate(listBranches)` · `listLanguages` · `git.getTree(recursive)` (file extensions) · latest 10 commits pe `getCommit` (key commits).

**Computed in code:** commits per day (date map), commits by weekday, contributors (commits + lines), file types % (tree blobs by extension), avg issue resolution days (closed issues, `created → closed`, PRs filter out via `pull_request` field), avg "PR review" days (`created → closed`), key commits = **impactScore** heuristic `msgLength×0.01 + filesChanged×0.5 + additions×0.01 + deletions×0.01`, top 5.

**UI:** Recharts — line/bar charts, contributor cards, languages, file types, key commits, stats.

**Gaps:** API call explosion — 1000 commits + 10 authors ≈ 10 pages + ~500 `getCommit` (sequential per author) → slow (tens of seconds) + 5000/hr rate limit jaldi; no caching → har visit pe repeat; contributors git **author name** se group (same banda alag names → split; login nahi); lines sirf pehle 50 commits/author (undercount, total jaisa dikhta); "PR review time" asal mein open→close time (unmerged closed bhi, review nahi); impactScore arbitrary weights (message length bhi count); key commits sirf latest 10 mein se; `getCodeFrequencyStats` pehli baar GitHub **202** (computing) deta → empty chart, handle nahi; UTC date grouping; auth check nahi.

### 8. PR & Issues — full flow

Page `/project/[id]/prAndissue` — **server component** → `PRandIssues(projectId)` server pe → props `PRAndIssuesClient` ko.

**Server:** `githubUrl` → `paginate(issues.listForRepo, state: "all")` + `paginate(pulls.list, state: "all")`. GitHub issues API PRs bhi return karta hai → `!i.pull_request` se asli issues alag. Format: number, title, state, dates, author login, labels (issues) / requested reviewers (PRs). Avg issue resolution + avg PR close time (same as analytics).

**Client:** tabs PRs / Issues, filter all/open/closed, sort (created/updated asc/desc) — sab client-side array pe. Header: open issues count + averages.

**Gaps:** saare PRs/issues ek saath (bade repo pe hazaaron → slow page, payload bhari) — server-side pagination/filter nahi; merged vs closed alag nahi (dono `closed`); read-only (comment/close/create nahi); no caching; duplicate logic with `getRepoStatus` (dono same issues/PR fetch + same averages); auth check nahi.

**Ek line dono ke liye:** GitHub API se live data → server pe aggregate → charts / lists. No AI, no DB.

### 9. Billing / Credits

**Honest:** `/billing` page sirf **static pricing UI** hai — hardcoded `demoPlans` (Starter $29, Professional $79, Enterprise $199), saare buttons `/create` pe. **Payment integration nahi** (Stripe/Razorpay nahi), user ke credits bhi is page pe nahi dikhte.

Asli credit system sirf yahan: `User.credits` default **200** (Prisma) → `/create` pe `checkCreditsAndStructure` file count vs credits dikhata → `CreateProject` mein `decrement: fileCount`. Top-up ka koi rasta nahi (README wala `/api/add-credits` exist nahi karta). Q&A / commits / meetings credits nahi kaat'te — sirf indexing.

### 10. Join Project (invite)

**Invite:** dashboard pe `InviteButton` → link `{origin}/join/{projectId}` → copy to clipboard → teammate ko bhejo.

**Join:** `/join/[projectId]` (client) → `useSession` → unauthenticated ho toh redirect (`/auth/signin` — **galat route**, app ka login `/login` hai) → "Join Project" button → server action `JoinProject(projectId)`: session check → project exist? → `UserToProject` mein `userId_projectId` composite unique se already-member check → nahi toh row create → "User successfully added" → client `/project/{id}/qa` pe.

Member banne ke baad: Projects list mein dikhta hai (membership-based), aur project ke saare features use kar sakta hai. Credits creator ke kate the — joiner ke nahi kat'te.

**Gaps:** invite "token" = projectId hi hai → expiry nahi, revoke nahi, owner approval nahi; projectId har project URL mein hai → URL dekh liya toh koi bhi join kar le; roles nahi (owner/member sab barabar), member remove nahi; unauthenticated redirect galat route pe (404).

### 11. Reindex

**Kya:** `GET /api/reindex?projectId=…` (`src/app/api/reindex/route.ts`) + CLI `scripts/reindex-project.ts`. **UI button nahi** — URL manually hit karna padta (create ka message "reindex from Ask me" bolta hai, lekin button hai nahi).

**Flow:** session check (sirf **production** mein; dev mein bina login allow, broken projects recover karne ke liye) → `projectId` query param → status `INDEXING` → wahi `RepoGenerateEmbeddings` (load → summarize → embed → upsert same IDs) → `{ message, embeddedFiles }`. Error → status `FAILED`, 500.

**Kab chahiye:** indexing fail / timeout, code change ke baad stale index, embedding model badla (e.g. `text-embedding-004` band hua → `gemini-embedding-001`, purane vectors incompatible).

**Bug:** route aur script dono success pe status `COMPLETED` set **nahi** karte (sirf `CreateProject` karta hai) → reindex ke baad project `INDEXING` pe hi reh jaata → Ask Me "not indexed yet" bolega, jab tak DB mein manually update na ho.

**Gaps:** state-changing kaam **GET** pe (link prefetch / CSRF se trigger ho sakta); production mein bhi sirf login check, membership nahi → koi bhi logged-in user kisi ka bhi project reindex kara ke API quota jala sakta; credits nahi kat'te; sync request (timeout); namespace clear nahi (deleted files ke stale vectors).
**Gaps:** no auth/membership check (IDOR); no chat memory (follow-up "aur isme?" toot jaata hai); topK 5 + 1 vector/file → multi-file sawaal pe kam context; 2000-char code slice → answer mein file ka bada hissa missing; normalization no-op; 0.15 threshold bohot low → noise; pure vector search (no keyword/BM25 hybrid, no reranker) → exact function names miss ho sakte; full sourceCode of 5 files browser ko jaata hai; prompt injection (repo code ke andar instructions) ka defense nahi; no evals.

---

## Q&A

### Q1. GitSaathi 2 min mein explain kar.

**Answer (spoken ~2 min):**

Haan, toh mera project GitSaathi hai — Saathi matlab companion, so basically GitHub ka AI companion.

Problem yeh thi ki jab bhi koi naya banda kisi bade codebase pe aata hai, usko samajhne mein bohot time lagta hai — files dhundna, commits padhna jo cryptic hote hain, meetings mein jo baatein hoti hain woh lose ho jaati hain, aur PRs issues alag jagah. Toh maine ek aisi app banayi jahan aap apna GitHub repo link karte ho, woh code index ho jaata hai, aur phir aap natural language mein codebase se sawaal pooch sakte ho.

Flow simple hai — create project pe repo connect karo, files embed hoti hain Pinecone mein, uske baad Ask Me pe aap questions poochte ho, RAG se relevant code milta hai, Gemini answer stream karta hai with file references. Uske alawa commits pe AI summaries aati hain actual diff pe, meetings pe audio upload karke transcript aur action items milte hain AssemblyAI se, analytics aur PRs issues bhi ek hi jagah dikhte hain.

Tech stack pe — Next.js 15 with React, TypeScript, PostgreSQL with Prisma, NextAuth with GitHub aur Google login, Gemini for AI, Pinecone for vector search, Octokit for GitHub API, AssemblyAI for meetings, Vercel Blob for audio. Credits system bhi hai — naye user ko 200 credits, indexing roughly file count pe deduct hoti hai.

Basically ek collaborative workspace jahan team code samajh sake, history padh sake, aur meetings lose na kare — sab AI ke saath ek dashboard mein.

**English interview version (~2 min):**

My project is GitSaathi — an AI-powered GitHub companion. The problem I wanted to solve is that understanding a large codebase takes a lot of time — finding files, reading unclear commits, and losing discussion from meetings. So I built an app where you link a GitHub repo, it gets indexed, and you can ask natural-language questions about the code. It also gives AI summaries of commits from the actual diffs, transcribes meeting audio into action items, and shows analytics, PRs, and issues in one place. I used Next.js, PostgreSQL with Prisma, NextAuth, Gemini, Pinecone, Octokit, and AssemblyAI.

---

### Q2. ChatGPT / Copilot / Cursor mein repo daal ke bhi codebase Q&A ho jata hai. Tera edge kya hai?

**Answer (spoken):**

Haan, fair point hai — main yeh nahi keh raha ki main Cursor ya Copilot ko replace kar raha hoon. Woh IDE ke andar coding assist ke liye strong hain. Mera edge product workflow pe hai.

Pehla — persistent project workspace. Aap ek baar repo link karte ho, indexing Pinecone pe project-wise namespace mein rehti hai. Har baar zip upload ya pura context dubara paste nahi karna padta. Team invite se same project share ho sakta hai — ChatGPT chat usually individual hoti hai.

Doosra — sirf Q&A nahi. Commits pe actual diff ki AI summary, meetings pe audio se transcript aur action items, analytics, PRs aur issues — sab ek GitHub-linked dashboard mein. Yeh combo general chat tools mein built-in nahi aata.

Teesra — answers codebase pe grounded hain RAG se, file references ke saath, scoped to that project. Fayda yeh ki hallucination kam aur relevant files dikhte hain. Tradeoff yeh ki indexing cost/time lagti hai, aur agar code change ho toh reindex chahiye — live IDE context jaisa instant nahi.

So honestly — daily coding ke liye Cursor better; onboarding, shared repo understanding, commit history aur meeting context ek jagah ke liye GitSaathi ka edge hai.

**English interview version:**

That’s a fair point — I’m not claiming to replace Cursor or Copilot. Those are stronger for day-to-day coding inside the IDE. My edge is more on the product workflow side.

First, it’s a persistent project workspace. You link a repo once, and the indexing stays in Pinecone under a project-specific namespace. You don’t have to re-upload a zip or paste the whole context every time. Teammates can also join the same project, whereas a ChatGPT chat is usually individual.

Second, it’s not only Q&A. You get AI summaries of commits from the actual diffs, meeting audio turned into transcripts and action items, plus analytics, PRs, and issues — all in one GitHub-linked dashboard. That combination isn’t built into a general chat tool.

Third, answers are grounded in the codebase through RAG, with file references scoped to that project. The benefit is fewer hallucinations and clearer pointers to relevant files. The tradeoff is indexing takes time and credits, and when the code changes you need to reindex — it’s not as instant as live IDE context.

So honestly: for daily coding, Cursor is better; for onboarding, shared repo understanding, commit history, and meeting context in one place, that’s where GitSaathi has an edge.

---

### Q3. Isme sabse zyada technical depth kaunse feature mein hai?

**Answer (English interview):**

The deepest technical part is the Ask Me feature — basically the RAG pipeline with indexing.

On create, we load the GitHub repo, summarize and embed file chunks with `gemini-embedding-001` into 768-dimensional vectors, and upsert them into Pinecone using the projectId as the namespace. At question time we embed the query, retrieve top-K matches with a score threshold, dedupe by file, and stream the answer with Gemini using those chunks as context plus file references.

That’s where most of the systems thinking sits — embeddings, vector search, namespace isolation, retries and caching for rate limits, retrieval quality vs cost. Meetings and commit summaries are valuable, but they’re more API integration; RAG is the core ML/systems depth.

**Tradeoffs:** Stronger grounded answers, but indexing cost/latency, and stale index if the repo changes without reindex. Tuning top-K and thresholds is a real tradeoff between recall and noise.

---

### Q4. Real users hain? Kitne repos index kiye, kitne bade?

**Answer (English interview — be honest, don’t invent metrics):**

I don’t have production-scale users yet. GitSaathi is mainly a portfolio / learning project that I built end-to-end and tested myself with my own GitHub repos (and maybe a couple of friends if true — fill in your real number).

On size: I’ve indexed small-to-medium repos — on the order of tens to a few hundred files, not monorepos with thousands of files. The credit model is roughly one credit per file with 200 starting credits, so that naturally caps how large a repo I can index in one go without topping up.

If they push on scale: I’d say the architecture is ready for multi-user (auth, project invites, per-project Pinecone namespaces), but I haven’t run a public launch or tracked DAU. What I’d measure next is indexing time vs file count, retrieval quality, and Gemini/Pinecone cost per question.

**Fill in before interview:**
- Real users / friends who tried it: ___
- Repos indexed (count): ___
- Largest repo (~files or stars): ___
- Deployed URL (if any): ___

---

### Q5. Teen features (Q&A, commits, meetings) kyu? Focus kyu nahi? Scope creep?

**Answer (English interview):**

It’s a fair concern — if this were a startup MVP for one paying customer, I would have focused only on codebase Q&A and made retrieval excellent.

For GitSaathi, the product thesis was one idea: help a team understand a GitHub project in one place. Code understanding is Q&A, history understanding is commit summaries, and discussion understanding is meetings. They’re not three random features — they’re three ways knowledge gets lost around the same repo.

That said, I won’t pretend depth is equal. Most technical depth is in RAG and indexing. Commits and meetings are thinner integrations on purpose, to show the full workflow. So yes, there’s some portfolio breadth — but I’d frame it as a coherent workspace, not feature spam.

If I continued this in production, I’d narrow: double down on Ask Me quality, auto-reindex on push, and only then deepen the other surfaces.

**Hinglish version:**

Haan, fair concern hai — agar yeh startup ka strict MVP hota kisi ek paying customer ke liye, toh main sirf codebase Q&A pe focus karta aur retrieval ko bohot strong banata.

GitSaathi mein product thesis ek thi: team ko ek jagah pe GitHub project samajhne mein help milni chahiye. Code understanding Q&A se, history understanding commit summaries se, aur discussion understanding meetings se. Yeh teen random features nahi hain — same repo ke around teen tarah se knowledge lose hoti hai, unko cover kiya.

Uske baad bhi main yeh nahi bolunga ki depth barabar hai. Sabse zyada technical depth RAG aur indexing mein hai. Commits aur meetings thinner integrations hain, workflow dikhane ke liye. Toh thoda portfolio breadth hai, haan — lekin main isko coherent workspace bolunga, feature spam nahi.

Agar production mein aage le jaata, toh narrow karta: pehle Ask Me quality aur auto-reindex, phir baaki surfaces deepen.

---

### Q6. Intervu aur GitSaathi dono mein RAG — common vs alag, kyu?

**Hinglish answer:**

Haan, dono mein maine RAG kiya, lekin domain alag hai isliye decisions alag hain.

Common pehle — dono mein Gemini embeddings (`gemini-embedding-001`, 768 dim), Pinecone as vector DB, aur multi-tenant isolation ke liye namespace — GitSaathi mein `projectId`, Intervu mein `resumeId`. Generation bhi Gemini Flash family pe hai with model fallback. Yeh stack isliye kyunki serverless-friendly hai, alag vector infra maintain nahi karni padi, aur Gemini pehle se stack mein tha.

Alag decisions domain se aate hain.

Index kya ho raha hai — GitSaathi mein GitHub source files; har file ka LLM summary embed hota hai, pura code metadata mein rehta hai answer ke liye. Intervu mein resume PDF ke raw 500-char chunks embed hote hain, kyunki resume pehle se prose hai aur goal factual grounding hai — “candidate ne yeh skill claim kiya?” — code samajhna nahi.

Retrieval kab — GitSaathi mein har question pe fresh Pinecone query, topK 5, score threshold, stream answer. Codebase Q&A mein har sawaal alag files maangta hai. Intervu mein interview start pe ek baar broad query, `resumeContext` session mein cache, baad ke turns reuse — voice interview mein latency kam rakhni thi, har reply pe dubara retrieve nahi.

Streaming vs structured — GitSaathi chat markdown stream karta hai; Intervu JSON turn protocol (next question, score) non-streaming.

Reindex — repos change hote hain isliye GitSaathi mein reindex + indexingStatus hai. Resume usually ek baar upload, Intervu mein abhi reindex path nahi (gap).

Tradeoff: same RAG idea, lekin GitSaathi retrieval-heavy hai, Intervu prefetch-and-reuse. Intervu ka nuksaan yeh ki baad ke sawaal pe chunks re-rank nahi hote; GitSaathi ka nuksaan indexing cost aur stale index without reindex.

---

## Indexing pipeline

### Q7. Poora flow bata: repo URL se Pinecone mein vector tak.

**Hinglish answer:**

Haan, toh create pe user GitHub URL aur project name deta hai. Pehle auth check — NextAuth session. Phir `checkCreditsAndStructure` URL se owner/repo parse karta hai, Octokit se recursively file count nikalta hai, user ke credits se compare. Agar files zyada hain credits se, fail — roughly 1 credit per file.

Credits enough hon toh Prisma mein Project banata hai `indexingStatus: INDEXING`, UserToProject link, credits decrement. Phir `RepoGenerateEmbeddings(projectId)` chalta hai.

Andar pehle project ka githubUrl uthata hai, LangChain `GithubRepoLoader` se `main` branch load — lockfiles, node_modules, dist, images ignore, recursive, concurrency 3, rate-limit pe retry with backoff. Har Document ke paas file path aur pageContent hota hai.

Phir files batches of 4 mein process. Har file pe Gemini se code summary (`summariseCode` / `summariseCode_2` alternate batches pe, rate limit spread ke liye), us summary pe `gemini-embedding-001` se 768-dim vector. Source code alag metadata ke liye rehta hai — embed summary hota hai, raw code nahi. Rate limit pe exponential backoff, max 3 retries.

Successful batch Pinecone records banate hain — id `projectId_sanitizedFileName`, values = embedding, metadata mein fileName, sourceCode, summary, projectId. `uploadToPinecone` index `gitbuddy` ke namespace = projectId pe upsert. Batches ke beech 1s delay. Sab khatam toh status COMPLETED, fail toh FAILED — project DB mein reh sakta hai, reindex possible.

Fayda: summary embed se semantic Q&A better, namespace isolation, batching se API limits handle. Nuksaan: indexing slow/costly, summary lose fine detail, main branch assume, code change pe reindex chahiye.

**English short:** URL → credit/file-count check → Project INDEXING + deduct credits → GithubRepoLoader → batch summarize → embed summary (768) → upsert Pinecone `gitbuddy` ns(projectId) → COMPLETED/FAILED.

### Q8. GithubRepoLoader kya karta hai? Alternatives (git clone, tarball, Octokit trees) kyu nahi?

**Hinglish answer:**

`GithubRepoLoader` LangChain community ka helper hai. Maine isko `loadGithubRepo` mein use kiya — GitHub URL do, woh `main` branch se recursive files laata hai, ignore list apply karta hai (lockfiles, node_modules, dist, images…), concurrency limit ke saath, aur har file ko LangChain `Document` banata hai — `pageContent` mein code, `metadata.source` mein path. Rate limit pe retries maine wrapper mein likhe.

Kyun yeh, alternatives nahi — mainly development speed aur pipeline fit. Mujhe seedha Document array chahiye tha summarizer → embed → Pinecone ke liye. LangChain pehle se dependency thi.

Alternatives ke tradeoffs:

**git clone** — full repo disk pe. Fayda: git native, branches/history. Nuksaan: serverless (Vercel-style) pe disk/ephemeral FS messy, cleanup, security, slow cold start. App primarily API/server-actions pe hai, durable filesystem assume nahi kiya.

**GitHub tarball / zipball API** — ek archive download, extract, parse. Fayda: bulk mein often faster, kam chhoti API calls. Nuksaan: extract memory/disk, ignore rules khud likhni, Document mapping khud. Large repos ke liye production mein yeh stronger choice ho sakta hai — maine abhi optimize nahi kiya.

**Octokit git trees + blobs** — tree recursive lao, har file blob fetch. Fayda: fine control, partial fetch, Octokit pehle se stack mein (file count bhi isi se). Nuksaan: zyada code, zyada round-trips, rate limit still pain. Loader basically isi pattern ko wrap karta hai convenience ke liye.

Honest: GithubRepoLoader convenience choice hai, “best possible ingest” claim nahi. Agar scale pe jaaun toh tarball ya trees API se ingest rewrite consider karunga — especially serverless constraints aur rate limits ke liye.

### Q9. Bahut badi file (10k lines) — summary kaise? Truncate / chunk / map-reduce?

**Hinglish answer:**

Indexing wale file summary mein honestly **truncate** hai — chunk ya map-reduce nahi.

`summariseCode` aur `summariseCode_2` dono `pageContent` ko pehle **15,000 characters** pe slice karte hain, phir woh truncated code Gemini ko dete hain for ~500-word summary. 10k lines ka file easily us limit se zyada hoga, toh sirf shuru ka hissa summary mein aata hai; baaki silently drop with a console warn.

Uske baad embedding pe bhi `generateEmbedding` summary text ko ~**9000 bytes** tak truncate kar sakta hai agar bohot lamba ho.

Commit diffs alag path hain — `aiSummariseCommit` mein 15k-char chunks + combine (“Part 1 / Part 2”) jaisa simple map-reduce vibe hai, lekin woh indexing file pipeline nahi hai, aur wahan bhi roughly pehle ~30k chars tak hi loop hai.

Kyun truncate: implement simple, kam API calls, cost/latency control. Nuksaan: badi file ke neeche wale functions miss — retrieval galat/incomplete. Chunk+map-reduce better hota accuracy ke liye lekin cost zyada. Production next step: function/class level split (AST) ya overlapping chunks → per-chunk summary → final reduce, multiple vectors per file.

### Q10. 2,000 files — cost, time, rate limits? Calculate.

**Assumptions (boliye interview mein):** ignore-filter ke baad 2000 files; har file = 1 summary (Flash) + 1 embed; batch=4, inter-batch delay=1s; avg summary input ~4k tokens (prompt+code), output ~600; embed ~700 tokens/summary. Pricing proxy: Gemini 2.5 Flash paid $0.30/1M in, $2.50/1M out; embedding-001 $0.15/1M in. (Code mein model names thode alag ho sakte hain — order-of-magnitude same.)

**Hinglish answer:**

Pehle product constraint: credits ≈ 1/file, default user 200 — **2000-file repo bina credit top-up index nahi hogi.**

API calls: 2000 summarize + 2000 embed ≈ **4000** Gemini calls.

**Cost (paid, rough):**  
Summaries: 2000×4k = 8M in → ~$2.40; 2000×600 = 1.2M out → ~$3.00 → ~**$5.4**.  
Embeds: 2000×700 ≈ 1.4M → ~**$0.20**.  
Total Gemini ≈ **$5–7** average. Agar bohot files 15k-char truncate pe hit karein toh **~$8–12**. Pinecone upsert + GitHub bandwidth alag, chhota.

**Time (code ke hisaab se):** 2000/4 = **500 batches**. Fixed delays hi ~500s ≈ **8 min**. Agar har batch wall-clock ~3–5s (4 parallel) + 1s delay → **~35–50 min** optimistic, no 429. Retries/backoff se easily **1–2+ hours**. Vercel serverless pe itna lamba request timeout risk — production mein queue/worker chahiye.

**Rate limits:** Free tier pe RPM/RPD jaldi khatam — 2000 generate calls hours tak fail/retry. Paid pe higher RPM, phir bhi burst of 4 parallel + continuous 500 batches spike karega; isliye batch=4, 1s delay, 3 retries, do API keys alternate. GitHub API bhi authenticated ~5k req/hour; loader concurrency 3 se load usually survive, lekin huge repo pe secondary bottleneck.

**Bottom line:** 2k files technically possible paid key pe ~$5–10 aur ~1 hour order, lekin aaj ka sync CreateProject path + 200 credits is scale ke liye design nahi — background job + higher credits + maybe skip/summarize-less for huge files.

### Q11. Batch size 4 kyu? Concurrency kaise? Dual summarizer rotation exactly?

**Hinglish answer:**

**Batch size 4:** Magic number / heuristic hai, formal load-test nahi. Comment mein bhi “Adjust based on API limits” likha hai. Idea yeh tha ki Gemini pe 4 parallel summarize+embed chalayein, phir 1s delay — rate limit aur throughput ka rough balance. Zyada concurrency (8–16) pe 429 jaldi; 1–2 bohot slow. Commit path pe alag `BATCH_SIZE = 2` hai — wahan diffs heavier feel hue.

**Concurrency control:** `p-limit` / queue library indexing mein use nahi ki. Manual pattern hai — `for` loop se slice(i, i+4), andar `Promise.all` on batch, beech mein `delay(1000)`, har call pe 3 retries + exponential backoff on 429. Fayda: zero extra dep, simple. Nuksaan: global concurrency cap nahi (sirf per-batch), adaptive rate limiting nahi, failed file `null` return karke skip. Repo load pe LangChain loader ka `maxConcurrency: 3` alag hai. Better hota: `p-limit` ya queue + token-bucket, worker pe background job.

**Dual summarizer:** Round-robin **batch parity** pe hai — failure-based fallback nahi.  
`(batchNumber % 2 === 0)` → `summariseCode` (`GEMINI_API_KEY`)  
odd batches → `summariseCode_2` (`GEMINI_API_KEY_2`)  
Poori batch ek hi key use karti hai. Agar key-1 pe 429 aaye toh same function pe retry, dusri key pe switch nahi. Embedding hamesha `repoEmbedding` ki primary key pe — rotate nahi. Purpose: do API quotas pe load failana jab free-tier limits hit ho rahe the. Code almost duplicate if/else — smell hai.

**Config-driven model pool kyu nahi:** Time/simplicity — jaldi do keys se kaam chalana tha. Pool better hota: `[{key, model, weight}]`, on 429 next provider, metrics, ek summarizer function. Aaj ka solution works-as-hack, production-grade router nahi — interview mein yeh gap openly bolunga.

### Q12. Retry: exponential backoff + jitter? 429 vs 5xx? Sync indexing + Vercel timeout?

**Hinglish answer:**

**Retry:** Exponential backoff **hai**, jitter **nahi**. Formula basically `BASE_RETRY_DELAY_MS * 2^(attempt-1)` — e.g. 1s, 2s, 4s. Jitter missing matlab concurrent workers same rhythm pe thump kar sakte hain (thundering herd). Ideal: `delay * random(0.5, 1.5)` ya full jitter.

**429 vs 5xx (indexing path):** Alag treat hote hain, lekin ideal nahi. `githubLoader` + file `summariseCode` mein **sirf 429 / “rate limit” string pe retry**; baaki errors — including **5xx** — **immediate fail** (`return null` / throw). Commit summarizer (`aiSummariseCommit`) thoda better: 429 retry, 403 no retry, other (5xx/network) pe bhi retry. Toh consistency nahi across codebase.

**Sync create + Vercel timeout:** `CreateProject` server action client se **await** hoti hai — pehle project DB mein `INDEXING`, credits deduct, phir poora `RepoGenerateEmbeddings` same request mein. `maxDuration` / `waitUntil` / background queue **nahi**. Local `next dev` pe Node lamba chal sakta hai isliye chhote repos “kaam karte” dikhte hain. Vercel pe hobby ~10s / pro default ~60s (plan/`maxDuration` pe depend) — badi indexing cross karegi.

**Timeout pe kya hota:** platform function kill. Catch incomplete → status **`INDEXING` pe stuck** reh sakta hai; credits already gaye; Pinecone pe **partial upserts** possible. UI pe create fail/error. Recovery: `/api/reindex?projectId=…` (status dubara INDEXING→COMPLETED/FAILED). Yeh known fragility hai — production fix: enqueue job (Inngest/BullMQ/QStash), create turant return, poll status.
