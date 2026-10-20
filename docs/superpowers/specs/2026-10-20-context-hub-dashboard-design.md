# context-hub — dashboard design

Date: 2026-10-20. Builds on the first build (`2026-10-10-context-hub-design.md`)
and the second build (`2026-10-20-context-hub-second-build-design.md`, Parts 5
and 6 deployed). Read those first; this document only adds to them.

## 1. Purpose

Today `https://hub.abdulmughnialfikri.com/` answers with one line of JSON.
The owner wants a page there that answers, without opening a terminal:
**"Is my context-hub working, and what has it been doing?"** That means what
was saved into the hub and what was read from it, by which tool.

The page is **for the owner only**. It is on the public internet, so
everything except a sign-in screen sits behind a sign-in.

### Goals

1. One glance shows health: server up, summaries not stuck, last sync, last
   backup and whether it reached off-site storage, and the deployed version.
2. Recent activity in both directions: **saved into the hub** (sessions
   uploaded from the PC, notes saved from claude.ai, deletions) and **read
   from the hub** (which tool read which project's page, searched for what,
   opened which session).
3. When something is wrong, the page says what: which summary failed and
   why, which project page could not be rebuilt, or that syncing has gone
   quiet.
4. Every way into the hub is listed, and any of them can be disconnected
   from the page.
5. Each project's briefing (the page assistants read) can be read here.
6. Works on a phone. Light and dark themes.

### Non-goals (this phase)

- Editing anything except disconnecting a connection and signing out.
- Search, charts, failed sign-in attempts, deleting notes or sessions.
- Access for anyone but the owner, or any multi-user model.
- A separate front-end application or hosting.

### Anti-goals (would make this a failure even if it worked)

- Anything about a project visible without signing in.
- A Disconnect that can cut off the owner's own hub by accident without a
  confirmation step.
- The hub gaining read access to other apps' backups (n8n's dumps hold email
  and payment data).

## 2. Decided

**Layout: a sidebar dashboard, Supabase-style** (the owner picked mockup B
from three). A left menu with four pages: **Overview, Activity, Projects,
Sign-ins**. Number cards across the top of Overview. On a phone the menu
collapses behind a button.

**Look: Plainfit's design.** Use the Plainfit app's tokens
(`~/project/job-application-engine/artifacts/job-engine/src/index.css`):

| Token | Light | Dark |
|---|---|---|
| background | `#FAFAF9` | `#151514` |
| foreground (ink) | `#18181B` | `#F5F5F3` |
| card | `#FFFFFF` | `#1C1C1A` |
| border (hairline) | `#E7E5E4` | `#2E2E2B` |
| muted text | `#78716C` | `#A8A29E` |
| success (only for healthy / saved) | `#15704A` | `#2E9E6B` |

Fonts: Plus Jakarta Sans for text, Space Mono for times, ids and numbers.
Corner radius 6 to 8 px. Green is used only to mean healthy or saved, never
as decoration. A switch toggles light and dark; the first visit follows the
device setting, and the choice is remembered in the browser.

**Sign-in: a `hub connect` code**, the same codes Part 5 uses for claude.ai
(`hub connect` on the PC, or `hub-admin connect-code` on the server). After
one code, the browser stays signed in for **30 days**. Wrong codes count
toward the existing failed-login limiter.

**Pages are served by the hub server itself.** No separate app, no React, no
front-end build step: server-rendered HTML plus one small script file for
the theme switch and the phone menu. Same server, same deploy. (The
designer's call. Plainfit uses React because it is a full application; four
mostly read-only pages do not need one, and plain pages are smaller and
easier to keep secure.)

## 3. The pages

### 3.1 Sign-in screen (`/login`, and `/` when signed out)

Shows the product name, one field for the sign-in code with the hint "Run
`hub connect` on your PC to get one", and a button. Nothing else: no
project names, counts or activity. A wrong or expired code re-shows the form
with "That code is wrong or has expired." After 10 wrong codes in 5 minutes
the existing limiter blocks that address for 15 minutes.

### 3.2 Overview (`/`)

- **Number cards:** Status (Healthy, or Needs attention), Projects,
  Sessions, Last sync (when the PC last reported a sync run, how long ago,
  and how many sessions it uploaded), Last backup (time, and whether it
  reached off-site storage).
- **Problems box**, shown only when there is something wrong, one line per
  problem:
  - each **failed** summary (still retrying): session id, project, the
    stored reason and the next attempt time;
  - each project page waiting to be rebuilt after a failure (from
    `state_retries`), with its next attempt time;
  - **summaries are off**: the server has no model key, so new sessions are
    not being summarised;
  - **summaries backing up**: summaries are on, but a summary has been
    pending for more than **1 hour**;
  - **sync is failing**: the PC's last reported sync run (section 4.1) ended
    with errors, or no sync run has been reported for more than **3 days**
    (the designer's call on the threshold);
  - **backup missing or late**: no successful backup in the last **26
    hours**, or the last one did not reach off-site storage while off-site
    storage is configured.
  - **Refused** summaries are also listed, marked "won't be retried until
    the session changes", but they do **not** count as a problem for the
    status: nothing on the page can clear them, and a status that never
    clears teaches the owner to ignore it. (The designer's call.)
- **Recent activity:** the latest 10 rows from the activity log (section 4),
  with a link to Activity.
- **Running version:** the deployed commit (from `IMAGE_TAG`) and when the
  server started.

"Healthy" means: no problems listed above. Anything in the Problems box makes
the status "Needs attention".

### 3.3 Activity (`/activity`)

The activity log, newest first, last **30 days**, paged (for example 50
rows a page). Each row: time, direction (saved in or read out), what (for
example "2 sessions", "read page", "search", "note", "deleted"), project
where known, and by whom (for example "your PC (collector)", "claude.ai",
"Claude Code (read token: laptop)"). A filter for direction (all, saved,
read) is enough; no free-text search.

### 3.4 Projects (`/projects`, `/projects/<project key>`)

A list of every project: name, session count, last activity, last sync and
the one-line summary. Clicking one shows its full briefing: the state page
(rendered from its Markdown), followed by its recent sessions and notes,
each with title, source, date and digest status. The same data `get_project`
returns; no new data.

### 3.5 Sign-ins (`/sign-ins`)

Every way into the hub, in three groups:

- **Claude apps** (OAuth grants): client name, permissions (read, save
  notes), signed in, last used.
- **Tokens** (the existing bearer tokens): label, kind (upload or read),
  created, last used. These are what the PC's `hub` command and Claude Code
  use.
- **Browsers** (dashboard sessions, section 5): when signed in, last used,
  and which one is **this browser**.

Each active entry has a **Disconnect** button. Disconnecting needs a second
confirmation that names the consequence, for example "Your PC's `hub sync`
will stop working until you create a new upload token on the server" for an
upload token, or "This signs this browser out" for the current browser.
Disconnecting a Claude app or token uses the existing revoke functions.
Revoked entries stay listed, greyed, with when they were revoked.

**Sign out** (in the menu) ends this browser's session.

## 4. The activity log (new)

The hub records saves today (sessions have `synced_at`) but not reads. A new
table records both. One row per event:

| Field | Meaning |
|---|---|
| time | when it happened |
| direction | `in` (saved) or `out` (read) |
| action | `upload`, `delete`, `note`, `list_projects`, `get_project`, `search`, `get_session` |
| project | the project key, when the event concerns one project |
| actor | who: an OAuth grant (its client name), a bearer token (its label and kind), or the collector |
| detail | a short, already-cleaned description: a session id, or a search query passed through the secret stripper and cut to 100 characters |

Rules:

- **Uploads:** only uploads that changed something are logged (an unchanged
  upload is not activity). Consecutive uploads to one project by one actor
  within two minutes may be shown as one row ("2 sessions") on the page; the
  table can keep one row per session.
- **Deletes** from `hub forget` are logged.
- **Every MCP tool call** is logged after it succeeds, with the project when
  the call names one.
- Rows older than **30 days** are deleted. Pruning happens as part of normal
  writes or the worker loop; no new background job.
- The log is for display only. Nothing else reads it.
- **Forgetting erases traces.** When `hub forget` deletes a session, its log
  rows go too; when it deletes a project, every row for that project goes.
  The deletion itself is logged as one row: for a session, with its project
  but no session id; for a whole project, with no project at all. (The
  designer's call: forgetting something should also forget where it was
  read and searched.) So rows need a project reference and, where there is
  one, a session reference that deletes can match.

### 4.1 Sync runs (the owner chose this)

The server only hears about uploads that changed something, so it cannot
tell a quiet week from a broken sync. So the PC reports every run:

- At the end of every `hub sync` (not `--dry-run`), the collector sends a
  short report to a new ingest-scoped API route: when the run finished, how
  many sessions it uploaded and how many were unchanged, and how many errors
  it hit (counts only, no file paths or content). A run that could not reach
  the server cannot report; the dashboard then shows the previous report and
  its age.
- The server keeps the latest report per upload token, plus enough history
  for the Activity page to show sync runs as rows ("sync: 2 uploaded, 205
  unchanged" by "your PC").
- A failure to send the report must not make `hub sync` fail or print an
  error that looks like the sync failed; at most one quiet line.
- This needs the owner to rebuild the `hub` command on the PC once after the
  change (as for `hub connect`).

## 5. Browser sessions (new)

- A successful code on `/login` creates a session: a random value stored
  only as a hash, in a new table, with created and last-used times and a
  30-day expiry.
- The browser holds it in a cookie that is `HttpOnly`, `Secure`,
  `SameSite=Strict`, and limited to this host and path `/`.
- Every page and action checks the session. An expired or revoked session
  goes back to `/login`.
- Actions (Disconnect, Sign out) are POST forms. Each carries a per-session
  anti-forgery token that the server checks, in addition to `SameSite`.
- Browser sessions appear on the Sign-ins page and can be disconnected like
  anything else.
- Browser sessions grant access to the dashboard only. They are not accepted
  on `/mcp` or `/api/*`, and OAuth and bearer tokens are not accepted for the
  dashboard.

## 6. Backups: a status file, not the backup folder

The backup scripts run on the server outside the hub's container, and their
folder (`/opt/stack/backups`) also holds n8n's dumps. The hub must not see
that folder. Instead:

- `scripts/backup-context-hub.sh` in `~/project/vps-stack` writes a small
  JSON status file after each run, for example
  `/opt/stack/backups/status/context-hub.json`, with: when the run finished,
  whether the local backup succeeded, its size, whether off-site storage is
  configured, and whether the off-site upload succeeded. It writes the file
  on failure too, so a failed run shows as failed.
- The hub's compose file mounts only `/opt/stack/backups/status` into the
  container, read-only.
- The dashboard reads that file. If it is missing, Overview says "No backup
  status yet" (not an error until 26 hours have passed since the hub
  started).

The cron schedule and the backup itself do not change.

## 7. Constraints carried over

- Deployment follows `~/project/vps-stack`: CI builds the image, the server
  only pulls; `docker compose` only on the server; the compose change is a
  vps-stack commit. Ask the owner before changing the server.
- Database changes are new migrations only.
- No secret value appears on a page: tokens and codes are never shown, only
  labels and times. Search queries in the log pass through the secret
  stripper first.
- All text from the database (project names, titles, summaries, state pages,
  search queries) is escaped. The state page's Markdown is rendered by code
  that escapes first and produces only a small fixed set of elements
  (headings, paragraphs, lists, bold, inline code, links), with no raw HTML.
- A strict Content-Security-Policy: scripts and styles only from the hub
  itself (plus the font host, if fonts are loaded from Google Fonts), no
  inline scripts, framing refused.
- The existing behaviour stays: `/healthz`, `/api/*`, `/mcp`, `/oauth/*`,
  `/.well-known/*`. The JSON landing response at `/` is replaced by the
  dashboard; a monitoring check should use `/healthz`.
- Commits carry no Co-Authored-By or other attribution trailers.
- All existing tests keep passing.

## 8. Left to the builder

- Table layouts for the activity log and browser sessions.
- The Markdown renderer, within section 7's limits.
- Whether fonts are self-hosted or loaded from Google Fonts.
- Exact wording beyond what this document fixes, page size on Activity, and
  how upload rows are grouped on screen.
- How the phone menu opens and closes.
- How IMAGE_TAG reaches the server process (it is already in the server's
  `.env`, which the container reads).
