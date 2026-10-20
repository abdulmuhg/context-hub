# context-hub — second build design

Date: 2026-10-20. Builds on the first build
(`2026-10-10-context-hub-design.md`), which is complete, deployed at
`https://hub.abdulmughnialfikri.com` and meets all five of its success
criteria. Read that spec first: everything it says about storage, secret
stripping, the personal data filter, tracking, digests and deployment still
holds unless this document changes it.

## 1. Purpose

The first build serves AI tools that run on the developer's PC and can send a
bearer token: Claude Code, Codex, Antigravity. The developer has said he is
focusing on Claude, and much of his Claude use is in the chat apps: claude.ai
on the web, the Claude desktop app's chat, and Claude mobile. Those apps can
reach the hub only as a **custom connector**, and a custom connector on a
personal plan needs OAuth sign-in. A bearer token does not fit that flow.

The second build closes that gap in three parts, built and shipped in this
order:

1. **Sign-in for the Claude apps (Part 5).** The hub becomes a custom
   connector. The developer adds `https://hub.abdulmughnialfikri.com/mcp`
   once in claude.ai, signs in, and from then on the web, desktop and mobile
   chats can call the same four lookup tools Claude Code uses.
2. **A `save_note` tool (Part 6).** A chat can write a short note into a
   project on the developer's request, for example the conclusion of a
   planning conversation. Notes then show up in `get_project`, `search` and
   the state page, from every tool.
3. **An importer for claude.ai exports (Part 7).** Past and future claude.ai
   chats come in from claude.ai's data export file, through the same
   track-before-upload rules as everything else.

Each part is useful alone, and each gets its own implementation plan.

### What this build is not

- Not the second brain. That remains a separate project.
- Not a dashboard or a web interface for browsing the hub. The only web page
  this build adds is the sign-in page. (A dashboard is a possible third build.)
- Not multi-user. There is one owner, and the sign-in proves you are that
  owner.
- Not live sync of claude.ai chats. claude.ai has no API for reading your
  chat history; the export file is the only supported route. Scraping
  claude.ai is ruled out.
- Not for ChatGPT or the Gemini app. Their connector support differs and is
  not checked here. The OAuth work should not rule them out, but nothing is
  built or tested for them.

### Success criteria

1. In claude.ai on the web, the developer adds a custom connector with the
   URL `https://hub.abdulmughnialfikri.com/mcp` and the default settings,
   signs in once, and asks "where did we leave off on jsonroom?". The answer
   comes from `get_project`. The same connector then works in the Claude
   desktop app's chat and in Claude mobile without being added again.
2. In a claude.ai chat, "save this to the hub under context-hub" stores a
   note. Claude Code then finds it with `search` and sees it in `get_project`
   for that project, and the state page reflects it after its next update.
3. After `hub import claude <export file>`, `hub projects` lists the imported
   chats under their own project keys, all untracked. Nothing from the export
   reaches the server until the developer tracks or maps a project and runs
   `hub sync`. Once a project is tracked and synced, its chats are searchable
   and digested like any other session.
4. Without completing sign-in, a Claude app can read nothing. Sign-in tokens
   expire and can be revoked with `hub-admin`. A sign-in that would send the
   user anywhere other than Claude's own callback address is refused.
   Repeated wrong sign-in codes are rate-limited. Existing bearer tokens keep
   working exactly as before.
5. claude.ai's normal first contact (a request without a token) never counts
   as a failed login, so Anthropic's shared addresses are never blocked by
   the hub's limiter.

## 2. Facts checked (2026-10-20)

From Anthropic's connector documentation (`claude.com/docs/connectors/
custom/remote-mcp` and `…/building/authentication`):

- Free, Pro and Max users add a custom connector themselves under
  **Customize > Connectors > Add custom connector**, by URL. The same
  connector then works on claude.ai web, Desktop, mobile and Cowork, because
  they share one authentication system.
- Supported sign-in types for a server a user adds by URL:
  - OAuth with a **Client ID Metadata Document** (CIMD): Claude identifies
    itself with a client metadata document Anthropic hosts. This is the
    dialog's recommended option, **Use Claude's published identity**.
  - OAuth with **Dynamic Client Registration** (DCR, RFC 7591): Claude
    registers a client on each fresh connection.
  - Your own pre-registered OAuth client.
  - No authentication.
  - **Request headers** (a fixed token sent on every request): beta, limited
    to some organizations. The developer's dialog may or may not show it.
- Claude starts sign-in only on a **401** whose `WWW-Authenticate` header
  points at the protected resource metadata (RFC 9728). It ignores that
  header on a 200.
- The metadata's `resource` must equal the MCP URL exactly as the user
  enters it. Claude uses only the first entry of `authorization_servers`.
- The authorization server must publish RFC 8414 metadata. Claude uses CIMD
  only when that metadata has both `"client_id_metadata_document_supported":
  true` and `"none"` in `token_endpoint_auth_methods_supported`; otherwise it
  falls back to DCR, which needs a `registration_endpoint`.
- PKCE with `S256` on every request; metadata must advertise
  `"code_challenge_methods_supported": ["S256"]`.
- Claude requests the scopes in the 401's `scope` parameter, otherwise
  `scopes_supported` from the resource metadata, and adds `offline_access`
  when the authorization server lists it, to get a refresh token.
- The hosted apps' redirect URI is exactly
  `https://claude.ai/api/mcp/auth_callback`. (Some guides also mention
  `https://claude.com/api/mcp/auth_callback`.) Claude Code uses a loopback
  redirect on a random port.
- The token endpoint must accept `application/x-www-form-urlencoded`; DCR
  sends JSON. Claude refreshes tokens on a 401 and up to five minutes before
  expiry, expects `invalid_grant` for a dead refresh token, and public
  clients (CIMD and DCR are public) need rotating refresh tokens.
- Claude waits 10 s for discovery, registration and token endpoints, and
  30 s for refresh.
- Anthropic's requests come from `160.79.104.0/21`.

About the hub as it is today:

- `/mcp` answers a missing or wrong token with 401 and no `WWW-Authenticate`
  header (`apps/server/src/http.ts`).
- The failed-login limiter counts a request with **no** token as a failure
  (`authorise()` calls `recordFailure` whenever `verifyToken` returns
  nothing, and `verifyToken('')` returns null). The limiter keys on the
  first `X-Forwarded-For` hop, which for claude.ai will be an Anthropic
  address shared by many users.
- Tokens are a `tokens` table of sha256 hashes with scope `ingest` or `read`.
  The MCP endpoint is stateless (a fresh server per request) and requires
  scope `read`.
- The MCP SDK in use is `@modelcontextprotocol/sdk` 1.32.1. It ships OAuth
  server helpers, but they are built for Express; the hub uses plain
  `node:http`.

Not checked, and to be confirmed while building:

- The exact shape of a claude.ai export. Third-party descriptions agree on a
  ZIP with `conversations.json`, an array of conversations with `uuid`,
  `name`, `created_at`, `updated_at` and `chat_messages`, where each message
  has `uuid`, `sender` (`human` or `assistant`), `text`, `content` and
  `created_at`. Whether conversations carry their claude.ai Project, and how
  attachments and tool use appear, is unknown. **The developer should request
  an export now** (Settings > Privacy > Export data; it arrives by email), so
  Part 7 is built against a real file.
- Whether the developer's **Add custom connector** dialog offers Request
  headers. See section 3.4.

## 3. Part 5: sign-in for the Claude apps

### 3.1 Shape

The hub becomes its own OAuth authorization server, on the same host and in
the same process as the MCP endpoint. No third-party identity provider:
there is one user, and depending on an outside login service would add a
dependency and an account for no gain.

New endpoints, all on `https://hub.abdulmughnialfikri.com`:

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) | RFC 9728 metadata: `resource` = `https://hub.abdulmughnialfikri.com/mcp`, `authorization_servers` = [`https://hub.abdulmughnialfikri.com`], `scopes_supported` = the hub's scopes |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: issuer, endpoints below, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `response_types_supported: ["code"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `scopes_supported` including `offline_access` |
| `POST /oauth/register` | DCR |
| `GET /oauth/authorize` | The sign-in page |
| `POST /oauth/authorize` | The sign-in form's submit |
| `POST /oauth/token` | Code exchange and refresh |

`/mcp` without a valid token answers 401 with
`WWW-Authenticate: Bearer resource_metadata="https://hub.abdulmughnialfikri.com/.well-known/oauth-protected-resource"`.
A wrong token gets the same header, with `error="invalid_token"`.

Caddy needs no change: these paths are on the same host and are proxied like
everything else. The bare-address landing response stays.

### 3.2 How the owner proves it is them

The sign-in page asks for a **one-time connect code**, not a password. The
developer gets one by running, on the PC:

```
hub connect
```

The `hub` command asks the server for a code using the PC's existing ingest
token, and prints it. A code:

- is short enough to type on a phone (for example 8 characters from an
  unambiguous alphabet, shown in two groups of four);
- is valid for 10 minutes and for one sign-in;
- is stored only as a hash.

`hub-admin connect-code` on the server does the same, for when the PC is not
at hand.

Why a code rather than a password: there is no password to choose, store,
leak or reset; a stolen code is useless after 10 minutes or one use; and
creating one requires a credential the hub already trusts. Wrong codes count
toward the existing failed-login limiter (10 failures in 5 minutes block that
address for 15 minutes), keyed on the browser's address. The sign-in page is
loaded by the developer's browser, not by Anthropic's servers, so this does
not affect Anthropic's addresses.

The sign-in page shows: which app is asking (the client's name from its
metadata), the host it will send the browser back to (required by the MCP
specification), what it will be allowed to do (read; and, once Part 6
exists, save notes, as a checkbox that is on by default), and the code field.
It is plain server-rendered HTML with no scripts from other sites and a
strict Content-Security-Policy. It must work on a phone.

### 3.3 Clients, tokens and limits

- **Which clients may sign in.** Only Claude's hosted apps. The authorization
  server accepts a sign-in only if the redirect URI is exactly
  `https://claude.ai/api/mcp/auth_callback` or
  `https://claude.com/api/mcp/auth_callback`, whether the client came by CIMD
  or by DCR. Anything else is refused before the sign-in page is shown. This
  is the strongest single protection the design has: even with a valid code,
  a token can only be delivered to Claude. (Claude Code keeps using its
  bearer token; loopback redirects are not accepted.)
- **CIMD.** The `client_id` is an HTTPS URL. The server fetches it with a
  short timeout, a small size limit, HTTPS only, refusing private and
  loopback addresses, and caches the result. It checks that the document's
  `client_id` equals the URL and that its `redirect_uris` include the
  requested redirect. Fetching a URL named by the caller is a server-side
  request forgery risk, which these limits contain; the builder may tighten
  it further, for example by allowing only hosts under `claude.ai`.
- **DCR.** Store the registered client (name, redirect URIs) in a new table.
  Refuse a registration whose redirect URIs fall outside the allowed set.
  DCR creates a client on every fresh connection; with one user this is a
  handful of rows, but old unused clients should be pruned.
- **Scopes.** `hub.read` for the four lookup tools, `hub.save` for
  `save_note` (Part 6), plus `offline_access` for a refresh token. Part 5
  already offers `hub.save` on the sign-in page (the checkbox in 3.2), even
  though the tool arrives in Part 6, so the developer's first sign-in covers
  both and he never has to remove and re-add the connector. The tool list is
  per grant: `save_note` is listed only to callers whose grant has
  `hub.save`. (The designer's call.)
- **Access tokens.** Opaque random strings with a recognisable prefix (so
  the existing secret stripper catches them, as it does `chub_` tokens),
  stored hashed, valid for one hour, bound to the MCP resource URL (RFC 8707:
  the `resource` parameter, when sent, must equal the MCP URL).
- **Refresh tokens.** Opaque, hashed, rotated on every use, with the old one
  invalidated in the same response. A refresh token unused for 90 days
  expires. Reuse of an already-rotated refresh token revokes the whole grant
  (the standard theft signal), with one exception: for 60 seconds after a
  rotation, presenting the refresh token that was just replaced issues a
  fresh pair and cancels the pair from the lost response, instead of
  revoking the grant. (Tokens are stored only as hashes, so the hub cannot
  hand back a token it already issued.) Claude waits up to 30 s for a
  refresh and may retry one whose answer was lost; without the grace window
  a single dropped response would sign the developer out on web, desktop and
  mobile at once. (The designer's call.)
- **Authorization codes.** Single use, 60 seconds, bound to the client, the
  redirect URI and the PKCE challenge.
- **The MCP endpoint** accepts either an existing `read` bearer token or a
  valid OAuth access token with `hub.read`. Nothing changes for Claude Code,
  Codex or Antigravity.
- **Revocation.** `hub-admin oauth list` shows grants (client name, scopes,
  created, last used); `hub-admin oauth revoke <id>` ends one, invalidating
  its access and refresh tokens immediately.
- **Endpoint speed.** Discovery, registration and token responses must come
  back well inside Claude's 10-second limit. They are local SQLite lookups,
  except the CIMD fetch, which needs its own short timeout.

### 3.4 Limiter fix

All of claude.ai's requests to `/mcp` and `/oauth/token` come from
Anthropic's shared addresses, and some of them routinely carry a credential
that is present but no longer good: an access token that has just expired
(Claude refreshes after the 401), or a grant that was revoked. Anyone else
on claude.ai could also point a connector at the hub with a made-up token.
Today `authorise()` checks whether the address is blocked *before* checking
the token, so ten such requests in five minutes would lock the developer's
own working connector out for 15 minutes. The rules (the designer's call):

- **A valid credential always gets through**, even from an address that is
  currently blocked. The block applies only to requests that fail. Blocking
  a failing request protects nothing on `/mcp` or `/api/*` anyway: tokens
  are 256-bit random values that cannot be guessed, so the limiter's real job
  is the one thing that *can* be guessed, the connect code.
- A request with **no** `Authorization` header never counts as a failure.
- An expired or revoked token that the hub itself issued (recognisable by its
  prefix and found by its hash) never counts as a failure. Only an unknown
  token does.
- At the token endpoint, a bad code or a dead refresh token gets the
  standard `invalid_grant` answer and does not count as a failure. Codes
  expire in 60 s and are bound to a PKCE verifier, so they cannot be
  usefully guessed.
- Wrong **connect codes** on the sign-in page are what the limiter is for.
  They count against the browser's address, as section 3.2 says.

With these rules, success criteria 4 and 5 both hold.

### 3.5 If the dialog offers Request headers

Before building Part 5, the developer opens **Add custom connector** and
checks for a **Request headers** section. If it is there, he can connect
today, with no new code: choose **No sign-in**, add the header
`authorization` with the value `Bearer <a read token>` (from `hub-admin token
create --scope read`), and paste the token only into that dialog, never into
a chat. This is an interim path only. The feature is a beta that Anthropic
can change, it gives the Claude apps a long-lived token instead of
expiring ones, and it offers no way to save notes with a narrower scope.
Part 5 is built either way.

### 3.6 Testing Part 5

- Unit and integration tests drive the full flow the way Claude does:
  unauthenticated `/mcp` → 401 with the header → resource metadata →
  authorization server metadata → DCR or CIMD (against a local fake metadata
  document) → authorize page → code submit → token exchange with PKCE →
  `/mcp` with the access token → refresh → rotated-token reuse revokes the
  grant.
- Refusals: a foreign redirect URI, a wrong PKCE verifier, an expired or
  reused code, an expired connect code, a wrong `resource`, and JSON on the
  token endpoint (form-encoded is required, so this must fail cleanly).
- The limiter: requests without a token never block; wrong codes do.
- The real test is manual, after deploy: add the connector in claude.ai, sign
  in from a phone and from a desktop browser, and run success criterion 1.
  The connector must also be removed and re-added once, to prove a fresh DCR
  or CIMD registration works.

## 4. Part 6: the `save_note` tool

### 4.1 Behaviour

A new MCP tool, available only to callers with `hub.save`:

```
save_note(project, title, text)
```

- `project` must resolve to a project that already exists on the server,
  using the same resolution as `get_project` (key or name). A note cannot
  create a project: projects come from tracking on the PC, and that rule
  stays.
- `title` is short; `text` is the note, in Markdown, with a size cap (for
  example 20,000 characters).
- The note is stored as a session with a new source, `note`, a generated id,
  one message, and `account_id` taken from the grant if known. It goes
  through the server's secret stripping like any upload.
- The server keeps no personal-data list (that lives on the PC in
  `personal.json`), so notes get secret stripping only. The tool's
  description tells the assistant not to include card numbers, phone numbers
  or credentials. The builder may also run the generic card-number check
  (`packages/core/src/personal.ts`) on the server.
- A note needs no digest: its text is its own digest, written by the person
  who asked for it. The worker stores it as the digest without a model call,
  and the state page update follows as for any new digest.
- The tool returns the note's session id, so the chat can tell the user
  where it went.

### 4.2 Guarding against unwanted writes

- The tool's description says to call it only when the user explicitly asks
  to save something. The connector's own permission controls in claude.ai
  (per-tool "Always allow" or "Blocked") apply as well.
- Notes are text in the hub. Everything that reads them is already told that
  hub content is a record, not instructions (MCP `INSTRUCTIONS`, and the
  `COMMON` prompt for digests and pages).
- Notes are easy to remove: `hub forget --session note:<id>` already works
  for any session, and `get_project` shows notes with their source, so they
  are visibly not conversations.
- The bearer tokens used by Claude Code stay read-only. Saving is possible
  only through an OAuth grant that includes `hub.save`. (The builder may also
  allow saving from Claude Code by adding a third token scope, but that is not
  required.)

### 4.3 Testing Part 6

Tests: saving with and without `hub.save`, to an unknown project, over the
size cap, with a secret in the text (stripped), and the note appearing in
`get_project`, `search` and the next state page. Manual: success
criterion 2.

## 5. Part 7: the claude.ai export importer

**Plan Part 7 only once a real export is in hand.** Two things the design
depends on can only come from the file: whether a conversation records its
claude.ai Project, and whether by name or by a stable id (5.2), and how tool
use and attachments appear (5.1). The collector's adapters also assume one
file per session, cached by size and modification time, while an export is
one large `conversations.json`, so how imports are stored and cached depends
on the real layout too. Parts 5 and 6 can be planned and built meanwhile.
(The designer's call.)

### 5.1 Behaviour

```
hub import claude <path to the export ZIP or its unpacked folder>
```

- The collector copies the export's conversation data into
  `~/.context-hub/imports/claude/` (or records its path), and a new adapter,
  source `claude-ai`, reads it during scan, the same way the other adapters
  read their tools' files. So imported chats follow every existing rule:
  secret stripping, the personal data filter, caps, content hashes,
  `skip`/`assign`/`alias`, and **nothing uploads until its project is
  tracked**.
- A later, newer export is imported the same way. Conversations are matched
  by their claude.ai `uuid`; changed ones get a new hash and re-upload, and
  unchanged ones are skipped. A conversation missing from a newer export is
  left alone (a deletion on claude.ai is not a reason to delete it from the
  hub; `hub forget` does that).
- Each conversation becomes one session: human messages as `user`, assistant
  messages as `assistant`, text content kept. Thinking is dropped, as for the
  other tools. Tool use (for example web search) becomes tool calls where the
  export shows them. Attachments' extracted text, if present, is kept within
  the existing caps; files and images are dropped and counted as warnings.

### 5.2 Which project a claude.ai chat belongs to

claude.ai chats have no folder and no git remote, so the first build's
project rule does not apply. The rule here:

- A chat inside a claude.ai **Project** gets the key
  `claude.ai/<project name>`, if the export records the Project. If the
  export also gives the Project a stable id, the importer remembers the
  name it first saw for each id, so renaming a Project on claude.ai does not
  split its chats across two keys.
- Any other chat gets `claude.ai/unfiled`.
- These appear in `hub projects` like any other key, untracked. The
  developer connects them to his real projects with the commands he already
  has: `hub alias claude.ai/Plainfit github.com/abdulmuhg/job-application-engine`
  moves a whole claude.ai Project, and `hub assign claude-ai:<uuid> <key>`
  moves one chat. Or he tracks `claude.ai/<name>` as a project of its own.

The design deliberately does not guess a project from a chat's content. A
wrong guess would upload a chat into a tracked project the developer did not
choose, which breaks the first build's promise that only what he tracks
reaches the server.

### 5.3 Testing Part 7

The adapter is tested against fixtures cut down from the developer's real
export (with personal content replaced), covering: a chat in a Project, a
chat outside any Project, attachments, tool use if the export has it, an
empty chat, and a second, newer export with one changed and one removed
conversation. Manual: success criterion 3.

## 6. Constraints carried over

- No secret value is ever printed, logged or pasted into a chat by an
  assistant working on this. Connect codes and tokens are created by the
  developer and shown only to him.
- Deployment follows `~/project/vps-stack` (CI builds the image, the server
  only pulls; `docker compose` only on the server; mem_limit and `expose`,
  not `ports`).
- Database changes are new migrations; nothing edits an existing one.
- Commits carry no Co-Authored-By or other attribution trailers.
- The first build's bearer-token paths, collector behaviour and success
  criteria must keep passing unchanged.

## 7. Left to the builder

- The OAuth implementation: the SDK's helpers adapted to `node:http`, or a
  small hand-written authorization server. A hand-written one is likely
  simpler here, given one user and an allowlist of two redirect URIs, but it
  is the builder's call.
- Table layouts for clients, grants, codes and tokens, and whether OAuth
  tokens share the `tokens` table or get their own.
- Exact token prefixes, code alphabet, and the cap sizes named above as
  examples.
- The sign-in page's wording and look, within section 3.2.
- How `hub connect` asks the server for a code (a new ingest-scoped API
  route is the obvious way).
- Whether to also allow the CIMD document's host to be pinned to Anthropic's
  domains.
- How the importer stores or references export files, within section 5.1.
