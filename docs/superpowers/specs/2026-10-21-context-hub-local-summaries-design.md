# context-hub — summaries written on the owner's computer

Date: 2026-10-21. Builds on the first-build design
(`2026-10-10-context-hub-design.md`, sections 9 "Digests" and "Project state
page") and the model-spend work merged in PR #9. Agreed with the owner in
conversation; points marked **(builder's call)** or **(my call)** were not.

## Why

Today the server writes every session digest and project state page through
the Anthropic API, with the hub's own `ANTHROPIC_API_KEY`. That is a second
bill on top of the Claude plan the owner already pays for (Pro), and the
model-spend tracking and daily limit exist only to keep that bill in check.

The owner wants the hub to be storage and search. Everything that reaches the
hub should arrive finished: cleaned **and** summarized on the owner's own
computer, by Claude Code running on the owner's Claude sign-in. The hub's API
key stays as an optional fallback, and the owner will decide later what else
it may be used for (clean-ups, re-summarizing and so on). That later use is
not part of this design.

## Goals

- `hub sync` (and auto-sync) writes digests and state pages with Claude Code
  on the owner's computer (`claude -p`), using the owner's Claude plan.
- A main session is uploaded **only together with its digest**. If the digest
  cannot be written, the session waits on the computer and the next sync tries
  again.
- The server works fully with no `ANTHROPIC_API_KEY`: storing, search,
  lookups, the dashboard, and no "summaries are off" warning.
- Digests are better than today's Haiku digests: the default model is Sonnet
  5.5 at low effort.
- Existing Haiku digests can be rewritten with the new model, including for
  sessions whose local transcript file is already gone.

## Non-goals

- New uses of the server's API key. It keeps only the fallback role below.
- Changes to cleaning (secret stripping, personal data filter), search, the
  MCP lookup tools, sign-in, or how documents and notes are stored.
- Summarizing documents (`source = 'doc'`) or subagent transcripts. They are
  not digested today and are not digested after this change.
- Measuring the Claude plan's remaining usage. Claude Code does not expose it;
  the hub reacts to "limit reached" when it happens.

## Anti-goals (a failure even if it works)

- **Spending the hub's API key silently.** No step may call the Anthropic API
  with the server's key except the fallback, and only when the owner has set a
  key on the server.
- **Billing an API account from the computer, or borrowing a host's
  sign-in.** If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set, Claude
  Code uses it instead of the plan. Auto-sync runs from a Claude Code hook and
  inherits that session's environment. Inside the Claude desktop app this
  includes `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and
  `CLAUDE_CODE_SIMPLE=1`, seen in a spike on 2026-10-21. The collector must
  start every `claude` with all `ANTHROPIC_*` and `CLAUDE*` variables removed,
  so it signs in from the owner's stored Claude login and nothing else.
- **Using up the owner's plan in one go.** A sync that hits the Claude usage
  limit blocks the owner's real Claude Code work for hours. Each sync is capped
  (decision 7).
- **The hub syncing its own summary runs.** Every `claude -p` call is a Claude
  Code session; none may be saved to disk, trigger the owner's hooks (above all
  the auto-sync `SessionEnd` hook), or load their CLAUDE.md, skills, plugins
  or MCP servers.
- **Two computers overwriting each other's state page** without noticing.

## Decided

### How a digest is written

1. **Claude Code on the computer writes it**, started by the collector as:

   ```
   claude -p --model claude-sonnet-5-5 --effort low
          --output-format json --json-schema <schema>
          --system-prompt <the hub's prompt> --tools ""
          --no-session-persistence --safe-mode --strict-mcp-config
   ```

   with the transcript sent on **stdin** (it can be far longer than a command
   line allows, especially on Windows). Flags checked against `claude --help`
   on the owner's Windows machine:
   - `--no-session-persistence`: the run is not saved, so the collector never
     sees it as a session.
   - `--safe-mode`: skips CLAUDE.md, skills, plugins, hooks, MCP servers,
     custom commands and agents.
   - **Not `--bare`**: bare mode authenticates only with `ANTHROPIC_API_KEY`
     and never reads the Claude sign-in, which defeats the purpose.
   - `--safe-mode`'s help text says "Auth, model selection, built-in tools and
     plugins, and permissions work normally", so it keeps the plan sign-in.
   - A spike run from inside the Claude desktop app could not reach the API
     (the app's sandbox only allows its own proxy), so a real run has not yet
     been confirmed. **The plan's first task is that check**, run from an
     ordinary terminal or the first real collector call: it succeeds with the
     clean environment above, returns the schema's object in
     `structured_output`, and leaves no new file under `~/.claude/projects`.
     If it fails, stop and bring the result back before building the rest.
2. **The model is pinned by full ID**, `claude-sonnet-5-5`, never the `sonnet`
   alias, so a new release never silently changes how digests read or how much
   of the plan they use. Effort `low`. Both are per-computer settings in
   `~/.context-hub/config.json`; the command to change them is the builder's
   call (for example `hub summaries model <id>`).
3. **The prompts and the digest logic move to `packages/core`**, so the
   computer and the server fallback produce the same digest: the system prompts
   now in `apps/server/src/llm-anthropic.ts`, the schemas in `llm.ts`
   (`DigestSchema`, `StateSchema`, `ReviewSchema`), and `renderLines`,
   `splitParts` and `renderDigest` from `transcript.ts`. Long sessions are
   split into parts and the part digests merged, exactly as the server does
   today. The collector implements the existing `Llm` interface
   (`digest`, `mergeDigests`, `projectState`, `reviewState`) by calling
   `claude -p`; tests use a fake, as the server's do.
4. **Empty sessions and refusals do not wait.** An empty session gets the
   fixed "Empty session" digest with no model call, as today. If Claude
   declines to summarize a session (a refusal does not change on retry), the
   session is uploaded marked `refused`, as the server does today, instead of
   waiting forever. A run counts as a refusal when `claude -p`'s JSON
   reports `stop_reason: "refusal"`. A session whose same content fails for
   any other reason on 3 syncs in a row is uploaded marked `failed`, so it
   shows on the dashboard instead of using the cap on every sync. The count
   is kept in the collector's state file. **(my call)**

### What `hub sync` does

5. **Order of a sync:**
   1. Read history, resolve projects, keep tracked sessions, clean them (as
      today, unchanged).
   2. Upload documents as today: they have no digest.
   3. For each new or changed main session: write its digest, then upload the
      session **and** its digest in one request, then its subagent
      transcripts. If the digest fails, nothing is uploaded for that session
      or its subagents, and their local sync state is not updated, so the next
      sync sees them as new work again. No separate queue is kept. Subagents
      wait with their parent so nothing of a waiting session is searchable
      **(my call)**. A subagent whose parent is already on the hub and
      unchanged uploads at once, as today.
   4. For each project that received new digests in this sync, update its
      state page (decision 10).
6. **Why it waits.** Owner's decision: the hub only ever holds a main session
   that arrived with a digest written by the owner's Claude. The cost, accepted:
   a session that could not be summarized is invisible to search, lookups and
   other computers until a later sync succeeds.

   **One exception, privacy first (owner's decision): re-cleaned sessions
   upload at once.** When the cleaning settings change (the settings
   fingerprint or `COLLECTOR_REVISION` in `config.ts`, for example a new
   personal-data entry), sessions already on the hub are cleaned again. In
   that sync, every session already on the hub whose cleaned version differs
   from the uploaded one goes up straight away, without waiting for a digest
   and outside the cap, whether or not the session itself also grew:
   - The server removes its old digest, including its search entry, because
     the old summary may hold the data that was just removed. It marks the
     project's page dirty, since the page may hold it too.
   - The upload is marked "summary to follow", so the server's fallback
     worker leaves it alone and never spends the key on it.
   - The collector records locally that the digest is owed. Following syncs
     write it and upload it on its own (decision 13), within the cap, before
     new work. Dirty pages from re-cleaning are rebuilt in the same order.
   - Sessions not yet on the hub follow the normal rule and wait for their
     digest; there is no old copy to replace.
7. **A cap per sync.** By default one sync writes at most **20** new digests
   **(my call on the number)**; a long session split into parts counts as one.
   Sessions over the cap wait for the next sync, newest first, so recent work
   reaches the hub soonest **(my call)**. `hub sync --all` (name is the
   builder's call) lifts the cap for one run, for catching up on a backlog when
   the owner is not using Claude. The cap matters most for auto-sync, which
   runs at the end of every session, often mid-work.
8. **When the usage limit is reached**, the sync stops writing digests for the
   rest of the run, uploads what it already has, and reports how many sessions
   wait and when the limit resets if Claude Code says so. Other failures (a
   timeout, Claude Code not signed in, bad output) skip that session and move
   on. Each call has a timeout **(builder's call on the length)**.
9. **What sync reports.** The summary line counts sessions waiting and why, for
   example `3 sessions waiting: Claude usage limit reached (resets 14:00)`.
   `hub status` and `hub doctor` show the waiting count too; `hub doctor` also
   checks that `claude` is installed and signed in. `hub sync --dry-run` lists
   what would be summarized and makes no model call.

### State pages

10. **The computer that wrote the digests updates the page**, with the same
    merge, 7-day full rebuild and review steps the server worker uses today
    (`apps/server/src/worker.ts`). The page combines sessions from all the
    owner's computers, so the collector first downloads from the server what
    it needs: the current page, its version, when it was last fully rebuilt,
    and the project's digests (for a rebuild). It uploads the new page with
    the version it started from.
11. **Versions stop overwrites.** Each state page gets a version number. The
    server saves an uploaded page only if its version is still the one the
    computer started from; otherwise it refuses, and the collector downloads
    again and redoes the merge, at most twice **(my call)**, then leaves the
    page marked as behind.
12. **A page that falls behind is caught up later.** If the page update fails
    (usage limit, refused version twice), the digests are already safe on the
    hub. "Behind" is the existing `dirty` flag on `project_states`. It is
    already set when a session moves project or is deleted (`store.ts`), and
    it already reaches assistants as `stale`, which is accurate. The status
    reply lists dirty projects, and the next sync of a tracked one from any
    computer rebuilds its page, even when that sync has no new sessions.
    **(my call to reuse `dirty`)** Page updates count toward the per-sync
    cap **(builder's call how)**.

### The server

13. **New and changed ingest endpoints** (all `ingest` scope):
    - `PUT /api/sessions/{source}/{id}` accepts an optional digest
      (`body` in the `DigestSchema` shape, `model`, or `refused` with a
      reason). The server checks the body against the schema, renders the
      stored text with `renderDigest`, and saves session and digest in one
      transaction. A main session that arrives without a digest becomes
      `pending` (the fallback, decision 15).
    - Reading what a state page update needs, and saving a page with its base
      version (decisions 10–11).
    - Saving a digest alone for a session already stored, with the session hash
      it was written from (for decision 18). Refused if the hash moved.
    - Listing sessions in a project with their digest's model, writer and
      status, and returning a stored session's messages (for decision 18).

    Paths and payload shapes are the builder's call. This lets the upload
    token read stored transcripts, which it cannot do today. Accepted: it is
    the owner's own computer, and the same token can already overwrite and
    delete them.
14. **Each digest and page records who wrote it**: the model, and the computer
    (the upload token's label) or "server". The dashboard shows this where it
    shows a session's digest status. The model-spend page and
    `hub-admin usage` keep counting only server calls, which after this change
    means fallback calls only. Recording token counts from `claude -p` output
    is the builder's call; it is never shown as spend.
15. **The fallback.** If the server has `ANTHROPIC_API_KEY`, its worker keeps
    writing digests for main sessions that arrive without one, with the daily
    limit. Only one case sends such a session: a computer where `claude` is
    not installed, syncing to a server that has a key. `GET /api/status`
    tells the collector whether the server has a key. Without a key, that
    computer's sessions wait like any other and sync says to install Claude
    Code. **(my call; the owner did not object when it was proposed)**

    The worker rebuilds a state page only right after writing a fallback
    digest for that project, not for every `dirty` page as it does today.
    Pages made dirty by computer digests, moves or deletes are left to the
    next sync, so the key is never spent on them. **(my call)**
16. **Notes need no model and no key.** A note (`source = 'note'`, created on
    the server by `save_note`) is its own digest today (`noteDigest` in
    `worker.ts`, model `note`). After this change the server writes that
    digest at once when the note is saved, with or without a key, and marks
    the project's page dirty so the next sync folds the note in. Notes are
    never resummarized.
17. **No key is normal.** The dashboard's "Summaries are off: the server has no
    model key" warning goes. A warning remains for pages that are behind and
    for sessions stuck in `pending` with no key to write them.

### Rewriting the Haiku digests

18. **`hub resummarize [<project>]`** (name is the builder's call) rewrites,
    for tracked projects, every main-session digest that was not written by a
    computer: today's Haiku digests, fallback digests, and `pending`,
    `failed` or `refused` ones. Notes and documents are left out. Digests a
    computer wrote are rewritten only when asked
    (`--model-not <id>`, builder's call on the flag), so two computers set to
    different models never keep rewriting each other's. **(my call; the owner
    asked whether Haiku's gaps can be recovered, and this is the command that
    does it)** The collector asks the server which sessions qualify, downloads each stored
    session's messages from the server, writes the digest with the current
    model, uploads the digest alone, and finally fully rebuilds each touched
    project's page. It downloads from the server rather than reading local
    files because Claude Code deletes local transcripts after 30 days by
    default, so for older sessions the server's copy is often the only one.
    It obeys the same cap, `--all` and usage-limit rules as sync.
19. **What a rewrite can and cannot recover.** It works from the full cleaned
    transcript the server stores, so anything Haiku missed or got wrong that is
    in the conversation can be recovered. It cannot recover what was never
    stored: stripped secrets and personal data, text a tool's adapter dropped
    (the parse warnings), or a subagent's own transcript, which digests do not
    read today. Tool calls are cut to 500 characters for the model, as today.

## Constraints

- Node 22, TypeScript, pnpm workspaces, `better-sqlite3`; match the existing
  code style.
- The collector runs on Windows and macOS. Starting `claude` must work on both
  (on Windows it may be `claude.cmd`).
- Auto-sync runs as a detached child with a lock that is treated as abandoned
  after 10 minutes (`apps/collector/src/auto.ts`, `LOCK_MAX_AGE_MS`). A sync
  that writes digests can run longer, so the lock must stay fresh while it
  works, or two auto-syncs would write the same digests twice. A session
  that ends while an auto-sync is still running is skipped by that run's
  lock, as today; it is picked up by the next sync, because its local state
  was not updated.
- Existing digests and pages stay valid; a migration adds the new columns
  (writer, page version, page-behind flag) with sensible values for old rows.
- Older collectors that upload sessions without digests must keep working:
  their sessions become `pending` (decision 13) and are handled by the
  fallback or by `hub resummarize`.

## Left to the builder

- Command names and flags not fixed above, endpoint paths and payloads, the
  call timeout, and how page updates count toward the cap.
- How `claude` is located, and how "usage limit reached" is recognized in its
  JSON output.
- Whether to keep splitting long sessions at today's 60,000-token limit. The
  100K-token price step does not apply to the plan, but smaller calls fail
  more gracefully.
- Converting the zod schemas to the JSON Schema `--json-schema` takes.
- Tests: a fake `claude` runner for the collector, and the existing fake LLM
  for the server fallback.
