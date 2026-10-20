# context-hub Part 6: `save_note` and tool selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Claude chat save a short note into an existing hub project on the user's request, and make the hub's tools the obvious choice when the user names one of their projects.

**Architecture:** A new server module `notes.ts` turns a note into a one-message session with source `note`, through the same secret stripping as uploads plus a card-number mask. The digest worker stores a note's text as its own digest without a model call. The MCP server is built per request with the caller's scopes: `save_note` is registered only for an OAuth grant with `hub.save`, and every tool description names the user's actual projects, read from the database.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22, better-sqlite3, `@modelcontextprotocol/sdk` 1.32.1, zod 4, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-context-hub-second-build-design.md`, section 4 (sections 1 and 6 apply). Part 5 is merged and deployed; see `docs/superpowers/plans/part5-deviations.md`, especially "A plain question does not pick the hub".

## Global Constraints

- `save_note(project, title, text)`: `project` resolves with the existing `resolveProject` (key or name) and must already exist; a note never creates a project. `title` 1 to 200 characters after trimming; `text` 1 to 20,000 characters after trimming. Over a limit is an error, never a silent cut.
- A note is a session: `source = 'note'`, `source_session_id = 'n_' + 16 random bytes base64url`, `parent = null`, `account_id = null`, `cwd = null`, `git_branch = null`, `started_at = last_activity_at = now`, one message `{ seq: 0, role: 'user', kind: 'text', ts: now, text }`.
- Title and text go through `stripSecrets`, then `filterPersonal` with `{ card: 'partial', list: 'off', entries: [] }` (the designer's call: a card number in a note saved from a chat is always an accident, so it is masked rather than only warned about).
- The ingest API keeps refusing source `note`: notes are created only through `save_note`.
- `save_note` is available only to an OAuth credential whose grant has `hub.save`. Bearer tokens (`read`) never see it. A caller without `hub.save` does not get the tool listed.
- A note's digest: `body = { goal: title, done: [], decisions: [], open_items: [], key_refs: [] }`, `text = "Note saved from a chat: " + title + "\n" + note text`, `model = 'note'`. No model call. The state page update follows as for any digest.
- Tool descriptions name the projects in the hub (names, not keys, comma-separated, at most 20, most recently active first). They are built per request from the database.
- Commits carry no Co-Authored-By or other attribution trailers. No secret values in code, tests or output. No database migration is needed; do not edit existing migrations.
- All existing tests keep passing.

## Review Focus

1. **Claude retries a tool call after a timeout** and saves the same note twice. A second `save_note` with the same project, title and text within 10 minutes returns the first note's id instead of creating a duplicate. Test in Task 1.
2. **An ambiguous or unknown project name** (`"hub"` matching nothing, or a name matching two keys) answers with the existing "No single project matches" error and its candidate list, and saves nothing. Test in Task 3.
3. **A read-only caller** (Claude Code's bearer token, or a grant without `hub.save`) neither sees `save_note` in `tools/list` nor can call it. Test in Task 3.
4. **Digests turned off** (no `ANTHROPIC_API_KEY`): a note still saves and is findable by `search` and `get_session` at once; its digest waits like any other. Test in Task 1 (search) and Task 2 (worker).
5. **Many projects**: the description lists at most 20 names and stays readable; with no projects it says the hub is empty rather than listing nothing. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/types.ts` (modify) | Add `'note'` to `Source` |
| `apps/server/src/notes.ts` (create) | `saveNote`: validate, clean, dedupe, store |
| `apps/server/src/worker.ts` (modify) | Notes are their own digest |
| `apps/server/src/mcp.ts` (modify) | Per-caller server: `save_note`, project-naming descriptions, `note` in the `search` source filter |
| `apps/server/src/http.ts` (modify) | `authorise` returns the credential; `deps.mcp` receives the caller |
| `README.md` (modify) | Saving notes from a chat |

---

### Task 1: Notes as sessions

**Files:**
- Modify: `packages/core/src/types.ts`
- Create: `apps/server/src/notes.ts`
- Test: `apps/server/test/notes.test.ts`, extend `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: `resolveProject(db, input)` and `upsertSession(db, session, now)` from `store.ts`; `contentHash`, `stripSecrets`, `filterPersonal` from `@context-hub/core`.
- Produces: `saveNote(db: Db, input: { project: string; title: string; text: string }, now: string): SaveNoteResult` where
  `SaveNoteResult = { ok: true; session_id: string; project: string; duplicate: boolean; redactions: number } | { ok: false; error: 'unknown_project'; candidates: string[] } | { ok: false; error: 'invalid'; message: string }`.
  `session_id` is the public form `note:<id>`; `project` is the resolved key.

- [ ] **Step 1: Write the failing tests** in `notes.test.ts` (seed one project by uploading a `makeSession` from `helpers.ts`):
  - `saves a note into an existing project` → `ok`, `session_id` matches `/^note:n_[A-Za-z0-9_-]{22}$/`, and `getSessionPage(db, 'note', id, 0)` returns one user message with the text.
  - `refuses an unknown project and saves nothing` → `{ ok: false, error: 'unknown_project' }`, session count unchanged.
  - `refuses an empty or over-long title or text` → title `''`, title of 201 characters, text `'   '`, text of 20,001 characters each give `error: 'invalid'` with a message naming the field and its limit.
  - `strips secrets and masks card numbers` → text containing `'gh' + 'p_' + 'a'.repeat(36)` and `4242424242424242` is stored with neither, and `redactions` ≥ 1.
  - `a retry within 10 minutes returns the first note` (Review Focus 1) → second identical call gives the same `session_id` and `duplicate: true`; the same call 10 minutes and 1 second later creates a new note.
  - `a note is searchable at once` (Review Focus 4) → `search(db, { query: 'unusualword' })` finds it with `session_id` starting `note:`.
  - In `http.test.ts`: `the ingest API refuses source note` → `PUT /api/sessions/note/x` with an ingest token → 400.
- [ ] **Step 2: Run** `pnpm --filter ./apps/server exec vitest run test/notes.test.ts test/http.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `saveNote`. Dedupe by looking for a `note` session in the same project, with the same `title`, whose single message has the same cleaned text and whose `started_at` is within the last 10 minutes. Add `'note'` to `Source` in core; leave `validate.ts` `SOURCES` without it.
- [ ] **Step 4: Run** the same command, then `pnpm test` and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Store notes as one-message sessions"`

### Task 2: A note is its own digest

**Files:**
- Modify: `apps/server/src/worker.ts`
- Test: extend `apps/server/test/worker.test.ts`

**Interfaces:**
- Consumes: `saveNote` (Task 1).

- [ ] **Step 1: Write the failing tests:**
  - `stores a note's digest without calling the model` → after `saveNote` and `runOnce`, `getDigest` is `{ status: 'ok', model: 'note' }`, its text starts with `Note saved from a chat: ` followed by the title, and `llm.calls` has no `digest` entry.
  - `the note then reaches the state page` → the next state call's digests include the note's `session_id`.
  - `a note waits like any other when digests are off` (Review Focus 4) → with no worker run, `getDigest` status is `pending` and the note is still found by `search`.
- [ ] **Step 2: Run** `…vitest run test/worker.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `digestOne`: when `due.source === 'note'`, build the body and text from the Global Constraints, read the note text from its one message, save with `model: 'note'`, then continue to `updateStateAfterDigest` as usual.
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Use a note's own text as its digest"`

### Task 3: `save_note` for callers allowed to save, and descriptions that name the projects

**Files:**
- Modify: `apps/server/src/mcp.ts`, `apps/server/src/http.ts`
- Test: extend `apps/server/test/mcp.test.ts`, `apps/server/test/http.test.ts`

**Interfaces:**
- Consumes: `saveNote` (Task 1); `Credential` from `tokens.ts` (Part 5).
- Produces:
  - `authorise(...)` in `http.ts` returns the `Credential` it accepted.
  - `AppDeps.mcp?: (req, res, body, caller: McpCaller) => Promise<void>` with `McpCaller = { canSave: boolean }` (true only for `{ kind: 'oauth' }` with `hub.save`).
  - `buildMcpServer(db: Db, caller: McpCaller = { canSave: false }): McpServer`; `handleMcp(db)` passes the caller through.
  - Tool `save_note` with input `{ project: string; title: string; text: string }`, returning `{ saved: true, session_id, project, duplicate }` or the existing `unknownProject` error shape.

Tool descriptions (exact; `<names>` is the comma-separated project list, or the text `The hub has no projects yet.` when empty):
- `list_projects`: `List the user's software projects and their AI coding history (Claude Code, Codex, Antigravity, and notes saved from chats). Projects in the hub: <names>.`
- `get_project`: `Catch up on one of the user's software projects: its current state and recent coding sessions. Call this first whenever the user names one of these projects or asks where they left off, before searching past chats: this history is not in the chat app's own chat history. Projects: <names>.`
- `search`: keep the current text, then append ` Covers the coding sessions and notes of: <names>.`
- `get_session`: unchanged.
- `save_note`: `Save a short note into one of the user's existing projects, so it is there in later sessions in any tool. Use only when the user asks to save, remember or record something for a project. Never include passwords, keys, card numbers or phone numbers. Projects: <names>.`
Add one line to `INSTRUCTIONS`: `When the user names one of their software projects, use these tools rather than searching past chats: coding sessions are stored here, not in the chat app.`

- [ ] **Step 1: Write the failing tests** in `mcp.test.ts` (using the SDK client as the existing tests do):
  - `a caller that can save sees save_note and can save` → `tools/list` includes `save_note`; calling it stores a note found by `get_project`'s recent sessions.
  - `a read-only caller does not see save_note` (Review Focus 3) → with `{ canSave: false }`, `tools/list` has the four lookup tools only, and calling `save_note` gives an error result.
  - `save_note with an unknown or ambiguous project returns the candidates and saves nothing` (Review Focus 2).
  - `descriptions name the projects` → with projects `alpha` and `beta`, the `get_project` description contains `alpha, beta` in most-recent-first order and the phrase `before searching past chats`.
  - `at most 20 names, and an empty hub says so` (Review Focus 5) → with 25 projects the list has 20 names; with none, the descriptions contain `The hub has no projects yet.`
  - `search accepts source note`.
  - In `http.test.ts`: `an OAuth grant with hub.save gets canSave; without it, or with a bearer token, it does not` (inject a fake `mcp` that records the caller).
- [ ] **Step 2: Run** `…vitest run test/mcp.test.ts test/http.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Read the project names with one query ordered by last activity, limited to 20.
- [ ] **Step 4: Run** them, then `pnpm test` and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add save_note for grants that can save, and name the projects in tool descriptions"`

### Task 4: Docs, deploy and the real test

**Files:**
- Modify: `README.md` (a "Saving notes from a chat" paragraph under "Connect claude.ai": ask the chat to save something to a named project; notes appear with source `note`; remove one with `hub forget --session note:<id>`)

- [ ] **Step 1:** Update the README and commit `git commit -m "Document saving notes from a chat"`.
- [ ] **Step 2 (reviewer and owner):** Merge to `main` and push; the push deploys. Check the container is healthy on the new image.
- [ ] **Step 3 (owner, manual):** In a new claude.ai chat, without naming the hub, ask "Where did we leave off on jsonroom?" and record whether it calls `get_project`. claude.ai caches tool lists, so if it does not, start another new chat or reconnect the connector and try again. Then ask the chat to save a one-line note to context-hub, and confirm from Claude Code that `get_project context-hub` lists it and `search` finds it.
- [ ] **Step 4:** Record the results, including whether the plain question now picks the hub, in `docs/superpowers/plans/part6-deviations.md` with any deviations, and commit.
