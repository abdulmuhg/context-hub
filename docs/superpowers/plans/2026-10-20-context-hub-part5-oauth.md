# context-hub Part 5: Sign-in for the Claude apps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://hub.abdulmughnialfikri.com/mcp` work as a claude.ai custom connector, with the hub as its own OAuth authorization server and a one-time connect code as the owner's proof of identity.

**Architecture:** New `apps/server/src/oauth/` module (config, store, clients, authorize page, token endpoint, routes) mounted by the existing `node:http` handler. `/mcp` accepts either an existing `read` bearer token or an OAuth access token with `hub.read`. The failed-login limiter is reshaped so valid credentials always pass and only guessable secrets (connect codes) and unknown tokens count. The collector gains `hub connect`.

**Tech Stack:** TypeScript (NodeNext ESM), Node 22 `node:http` and `node:crypto`, better-sqlite3, vitest, pnpm workspace. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-context-hub-second-build-design.md` (section 3; sections 1, 2 and 6 apply). Read it before starting.

## Global Constraints

- Public base URL comes from env `PUBLIC_URL` (production: `https://hub.abdulmughnialfikri.com`). Resource URL = `${PUBLIC_URL}/mcp`; issuer = `PUBLIC_URL`. Never derive either from the request's `Host` header. If `PUBLIC_URL` is unset, all OAuth routes answer 404 and `/mcp` keeps today's behaviour (no `WWW-Authenticate`).
- Allowed redirect URIs, exact string match only: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`. No loopback.
- Scopes: `hub.read`, `hub.save`, `offline_access`. Every grant has `hub.read`; `hub.save` only when the sign-in checkbox is ticked (default ticked); `offline_access` when requested.
- PKCE `S256` only. Token endpoint accepts only `application/x-www-form-urlencoded`. DCR accepts only `application/json`.
- Lifetimes: authorization code 60 s, single use; access token 3600 s; refresh token expires 90 days after its last use; rotation grace 60 s; connect code 10 min, single use.
- Token formats: access `chub_at_` + 32 random bytes base64url; refresh `chub_rt_` + 32 bytes; authorization code `chub_ac_` + 32 bytes. All stored as sha256 hex only. (The existing `chub_[A-Za-z0-9_-]{32,}` secret rule already strips them.)
- Connect code: 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, displayed `XXXX-XXXX`; input is upper-cased and has spaces and `-` removed before checking.
- Every OAuth JSON response sets `Cache-Control: no-store`.
- Responses to Claude must be fast (Claude waits 10 s; 30 s for refresh). CIMD fetch timeout 3 s, max 64 KiB, HTTPS only, refuse private/loopback/link-local addresses.
- Database changes go in a new migration (index 3 → `user_version` 4); never edit an existing migration.
- Existing bearer-token behaviour for `/api/*` and `/mcp` is unchanged except the limiter rules in Task 2. All existing tests must keep passing.
- No secret value is printed or logged. Commits carry no Co-Authored-By or other attribution trailers.

## Review Focus

1. **Form-action and redirects.** The sign-in form posts to `/oauth/authorize`, which answers 302 to `claude.ai`. Chrome applies the CSP `form-action` directive to that redirect, so a CSP of `form-action 'self'` silently breaks sign-in. The CSP must list `'self' https://claude.ai https://claude.com`. Test in Task 6 asserts the header.
2. **A stale or mistyped connect code** must re-show the page with the same hidden OAuth parameters and a plain error, so the user can retry without restarting from claude.ai. Test in Task 6.
3. **Reflected values on the page** (client name from a CIMD document or DCR, `state`, redirect host) are untrusted. All are HTML-escaped. Test in Task 6 with a client name containing `<script>`.
4. **Near-miss redirect URIs** (`…/auth_callback/`, `HTTPS://CLAUDE.AI/…`, `…?x=1`, `http://claude.ai/…`) are refused before the page is shown, with an error page and no redirect. Test in Task 6.
5. **Two refreshes racing with the same refresh token** (Claude retrying a lost response) within 60 s both succeed, and only the last pair issued stays valid. Test in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/db.ts` (modify) | Migration 4: OAuth and connect-code tables |
| `apps/server/src/oauth/config.ts` (create) | `OAuthConfig`, constants, metadata documents |
| `apps/server/src/oauth/store.ts` (create) | All SQL for clients, connect codes, grants, codes, tokens |
| `apps/server/src/oauth/clients.ts` (create) | DCR validation and CIMD fetch/validation |
| `apps/server/src/oauth/page.ts` (create) | Sign-in and error page HTML, escaping, CSP |
| `apps/server/src/oauth/authorize.ts` (create) | `GET`/`POST /oauth/authorize` |
| `apps/server/src/oauth/token.ts` (create) | `POST /oauth/token` |
| `apps/server/src/oauth/routes.ts` (create) | Routes `/.well-known/*`, `/oauth/*` to the above |
| `apps/server/src/tokens.ts` (modify) | `checkCredential`: bearer token or OAuth access token |
| `apps/server/src/http.ts` (modify) | New `authorise` rules, `WWW-Authenticate`, OAuth routes, `/api/connect-code`, form body reading |
| `apps/server/src/admin.ts` (modify) | `connect-code`, `oauth list`, `oauth revoke <id>` |
| `apps/server/src/main.ts` (modify) | Read `PUBLIC_URL`, pass `oauth` config |
| `apps/collector/src/upload.ts`, `apps/collector/src/cli.ts` (modify) | `hub connect` |
| `README.md` (modify), `~/project/vps-stack/context-hub/.env.example` (modify) | Docs and `PUBLIC_URL` |

Tests live beside the existing ones in `apps/server/test/` and `apps/collector/test/`.

---

### Task 1: Schema, config and store

**Files:**
- Modify: `apps/server/src/db.ts` (append to `MIGRATIONS`)
- Create: `apps/server/src/oauth/config.ts`, `apps/server/src/oauth/store.ts`
- Test: `apps/server/test/oauth-store.test.ts`, extend `apps/server/test/db.test.ts`

**Interfaces:**
- Produces (`config.ts`):
  - `interface OAuthConfig { publicUrl: string; fetchImpl?: typeof fetch; now?: () => Date }`
  - `const ALLOWED_REDIRECTS: readonly string[]`, `const SCOPES = ['hub.read', 'hub.save', 'offline_access'] as const`, `type HubScope = (typeof SCOPES)[number]`
  - `const TTL = { code: 60_000, access: 3_600_000, refreshIdle: 90 * 86_400_000, grace: 60_000, connectCode: 600_000 }`
  - `resourceUrl(cfg): string`, `protectedResourceMetadata(cfg): object`, `authorizationServerMetadata(cfg): object`
- Produces (`store.ts`), all taking `db: Db` first and `now: string` (ISO) where time matters:
  - `createConnectCode(db, now): { code: string; expiresAt: string }` (code is the display form `XXXX-XXXX`)
  - `consumeConnectCode(db, input: string, now): boolean`
  - `saveClient(db, c: { clientId: string; kind: 'dcr' | 'cimd'; name: string; redirectUris: string[] }, now): void`, `getClient(db, clientId): StoredClient | null`, `pruneClients(db, now): number`
  - `createGrant(db, g: { clientId: string; clientName: string; scopes: HubScope[] }, now): number`, `listGrants(db): GrantRow[]`, `revokeGrant(db, id, now): boolean`
  - `createAuthCode(db, c: { grantId: number; clientId: string; redirectUri: string; codeChallenge: string; resource: string }, now): string`
  - `takeAuthCode(db, code: string, now): { status: 'ok'; row: AuthCodeRow } | { status: 'reused'; grantId: number } | { status: 'invalid' }` — marks it used
  - `issueTokens(db, grantId, withRefresh: boolean, now): { access: string; refresh: string | null }`
  - `findToken(db, token: string): TokenRecord | null` where `TokenRecord = { hash; grantId; kind: 'access' | 'refresh'; expiresAt; replacedAt: string | null; replacedBy: string | null; grant: { scopes: HubScope[]; clientId: string; revokedAt: string | null } }`
  - `rotateRefresh(db, old: TokenRecord, now): { access: string; refresh: string }` — marks old `replaced_at`, records `replaced_by` (hash of the new refresh), extends idle expiry
  - `revokePair(db, refreshHash: string, now): void` — invalidates that refresh token and the access token issued with it
  - `touchGrant(db, grantId, now): void`

- [ ] **Step 1: Write the failing tests** in `oauth-store.test.ts`:
  - `connect codes are XXXX-XXXX from the allowed alphabet, work once, and expire after 10 minutes` — `createConnectCode` matches `/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/`; `consumeConnectCode(code.toLowerCase().replace('-', ' '))` → `true`; second call → `false`; a fresh code consumed at `now + 600_001 ms` → `false`.
  - `only hashes are stored` — after creating a connect code, auth code and token pair, no row in any OAuth table contains the raw strings (`SELECT * …` serialized, `not.toContain`).
  - `an auth code works once; a second use reports reused with its grant` and `expires after 60 s` → `invalid`.
  - `issueTokens gives chub_at_/chub_rt_ prefixes, and no refresh token when withRefresh is false`.
  - `revokeGrant makes findToken report the grant revoked`.
  - `pruneClients removes DCR clients older than 30 days with no grant, and keeps ones with a grant`.
  - In `db.test.ts`: `SCHEMA_VERSION` is 4 and a fresh database has tables `oauth_clients`, `connect_codes`, `oauth_grants`, `oauth_codes`, `oauth_tokens`.
- [ ] **Step 2: Run** `pnpm --filter ./apps/server exec vitest run test/oauth-store.test.ts test/db.test.ts` — expect FAIL (module missing / version 3).
- [ ] **Step 3: Implement.** Migration 4 creates the five tables: `oauth_clients(client_id PK, kind CHECK IN ('dcr','cimd'), name, redirect_uris JSON text, created_at, fetched_at)`, `connect_codes(hash UNIQUE, created_at, expires_at, used_at)`, `oauth_grants(id PK, client_id, client_name, scopes text space-separated, created_at, last_used_at, revoked_at)`, `oauth_codes(hash PK, grant_id FK → oauth_grants ON DELETE CASCADE, client_id, redirect_uri, code_challenge, resource, expires_at, used_at)`, `oauth_tokens(hash PK, grant_id FK ON DELETE CASCADE, kind CHECK IN ('access','refresh'), expires_at, replaced_at, replaced_by, pair_hash)` where `pair_hash` links an access token to the refresh token issued with it. Use `crypto.randomBytes` and `crypto.randomInt` (for the connect code). Metadata documents carry exactly the fields in spec 3.1, with `scopes_supported: SCOPES`.
- [ ] **Step 4: Run** the same command — expect PASS. Then `pnpm test` — all existing tests still pass.
- [ ] **Step 5: Commit** `git commit -m "Add OAuth and connect-code tables, config and store"`

### Task 2: Credentials and the limiter rules

**Files:**
- Modify: `apps/server/src/tokens.ts`, `apps/server/src/http.ts` (`authorise` and the `/mcp` 401)
- Test: extend `apps/server/test/http.test.ts`, `apps/server/test/tokens.test.ts`

**Interfaces:**
- Consumes: `findToken`, `touchGrant` (Task 1); `OAuthConfig`, `resourceUrl` (Task 1).
- Produces:
  - `checkCredential(db, token: string, now: string): { kind: 'bearer'; scope: Scope } | { kind: 'oauth'; grantId: number; scopes: HubScope[] } | 'dead' | null` in `tokens.ts`. `'dead'` = issued by this hub but expired or revoked: a revoked row in `tokens`, or a `chub_at_` token whose hash is found but is expired or whose grant is revoked. `null` = unknown. A `chub_rt_` token presented as a bearer is `null`.
  - `AppDeps.oauth?: OAuthConfig` in `http.ts`.
  - `/mcp` allows `bearer` with scope `read`, or `oauth` with `hub.read`.

- [ ] **Step 1: Write the failing tests** (new `describe('limiter rules')` in `http.test.ts`, limiter injected with a fake clock):
  - `requests without an Authorization header never count`: 50 × `POST /mcp` with no header → all 401, then a valid `read` token → 200 (or the MCP answer), never 429.
  - `a valid token passes even from a blocked address`: 10 unknown tokens → the 11th unknown gets 429; a valid `read` token from the same address → not 429.
  - `an expired hub-issued access token does not count`: 20 × an expired `chub_at_` token → 401 each, never 429.
  - `/mcp 401 carries WWW-Authenticate when oauth is configured`: header equals `Bearer resource_metadata="https://hub.test/.well-known/oauth-protected-resource"`; with a wrong token it also contains `error="invalid_token"`; with `oauth` unset there is no header.
  - `an OAuth access token with hub.read can call /mcp; an ingest bearer still cannot (403)`.
  - In `tokens.test.ts`: the four `checkCredential` outcomes.
- [ ] **Step 2: Run** `pnpm --filter ./apps/server exec vitest run test/http.test.ts test/tokens.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** New `authorise` order: no header → 401 (no failure); `checkCredential` valid → scope check (403 on wrong scope) → `touchGrant` for OAuth; address blocked → 429; `'dead'` → 401 (no failure); `null` → `recordFailure`, 401. `/mcp` 401s add `WWW-Authenticate` only when `deps.oauth` is set.
- [ ] **Step 4: Run** the same command, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Let valid credentials through the limiter and accept OAuth tokens on /mcp"`

### Task 3: Connect codes from the PC and the server

**Files:**
- Modify: `apps/server/src/http.ts` (route `POST /api/connect-code`), `apps/server/src/admin.ts`, `apps/collector/src/upload.ts`, `apps/collector/src/cli.ts`
- Test: extend `apps/server/test/http.test.ts`, `apps/server/test/admin.test.ts`, `apps/collector/test/cli.test.ts`

**Interfaces:**
- Consumes: `createConnectCode` (Task 1).
- Produces: `POST /api/connect-code` (scope `ingest`) → `200 { code, expires_at }`; `requestConnectCode(remote: Remote): Promise<{ code: string; expires_at: string }>` in `upload.ts`; `hub connect`; `hub-admin connect-code`.

- [ ] **Step 1: Write the failing tests:**
  - http: `connect-code needs an ingest token` — `read` token → 403; ingest → 200 with a code matching the format and `expires_at` = now + 10 min.
  - admin: `connect-code prints one code and its expiry`.
  - cli: `hub connect prints the code and how to use it` — output contains the code and the words `10 minutes` and `one use`, and does not contain the ingest token.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement.** `hub connect` output, exactly:
  ```
  Sign-in code: ABCD-EFGH
  Valid for 10 minutes, for one use. Enter it on the hub's sign-in page when claude.ai asks you to sign in.
  ```
  Add `connect` to the CLI usage text and `connect-code`, `oauth list`, `oauth revoke <id>` lines to the `hub-admin` usage (the `oauth` commands are implemented in Task 8).
- [ ] **Step 4: Run** the three test files, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add hub connect and hub-admin connect-code"`

### Task 4: Discovery endpoints

**Files:**
- Create: `apps/server/src/oauth/routes.ts`
- Modify: `apps/server/src/http.ts` (delegate `/.well-known/*` and `/oauth/*` to `routes.ts` when `deps.oauth` is set)
- Test: `apps/server/test/oauth-discovery.test.ts`

**Interfaces:**
- Consumes: metadata builders (Task 1).
- Produces: `handleOAuth(req, res, path, method, ctx: OAuthCtx): Promise<boolean>` (true if handled), where `OAuthCtx = { db: Db; cfg: OAuthConfig; limiter: AuthLimiter; address: string; readBody: () => Promise<Buffer> }`. Later tasks add their routes here.

- [ ] **Step 1: Write the failing tests:**
  - `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` both return `{ resource: 'https://hub.test/mcp', authorization_servers: ['https://hub.test'], scopes_supported: ['hub.read','hub.save','offline_access'] }` with `Cache-Control: no-store`.
  - `GET /.well-known/oauth-authorization-server` includes `issuer: 'https://hub.test'`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint` under `https://hub.test/oauth/`, `code_challenge_methods_supported: ['S256']`, `token_endpoint_auth_methods_supported: ['none']`, `client_id_metadata_document_supported: true`, `grant_types_supported: ['authorization_code','refresh_token']`, `response_types_supported: ['code']`.
  - `metadata ignores the Host header`: a request with `Host: evil.example` still gets `https://hub.test` values.
  - `without oauth configured, these paths are 404`.
- [ ] **Step 2: Run** `…vitest run test/oauth-discovery.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `routes.ts` and the delegation.
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Serve OAuth discovery metadata"`

### Task 5: Clients — DCR and CIMD

**Files:**
- Create: `apps/server/src/oauth/clients.ts`
- Modify: `apps/server/src/oauth/routes.ts` (`POST /oauth/register`)
- Test: `apps/server/test/oauth-clients.test.ts`

**Interfaces:**
- Consumes: `saveClient`, `getClient`, `pruneClients` (Task 1).
- Produces: `resolveClient(db, cfg, clientId: string, now): Promise<{ ok: true; client: StoredClient } | { ok: false; reason: string }>` — a `client_id` starting with `https://` is a CIMD URL: use the cache if fetched within 24 h, else fetch with `cfg.fetchImpl`, validate, save. Anything else is looked up as a DCR client.

- [ ] **Step 1: Write the failing tests:**
  - DCR: `registers a client with an allowed redirect` → 201 with `client_id`, `client_id_issued_at`, `redirect_uris`, `token_endpoint_auth_method: 'none'`; `refuses a foreign redirect` → 400 `invalid_redirect_uri`; `refuses token_endpoint_auth_method other than none` → 400 `invalid_client_metadata`; `refuses a non-JSON body` → 400.
  - CIMD (fake `fetchImpl`): `accepts a document whose client_id equals its URL and lists an allowed redirect`; refuses: `client_id` mismatch, no allowed redirect, `http://` URL, response over 64 KiB, fetch timeout (3 s, fake), a URL whose host is `localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`, `[::1]`; `uses the cache within 24 h` (fetch called once for two resolves).
- [ ] **Step 2: Run** `…vitest run test/oauth-clients.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Private-address refusal checks the URL host literally and, when it is a name, the addresses it resolves to (`dns.promises.lookup` with `all: true`); refuse if any is private. A DCR client's name is `client_name` or `"Unnamed client"`. Call `pruneClients` on each registration.
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Register OAuth clients by DCR or Client ID Metadata Document"`

### Task 6: The sign-in page

**Files:**
- Create: `apps/server/src/oauth/page.ts`, `apps/server/src/oauth/authorize.ts`
- Modify: `apps/server/src/oauth/routes.ts` (`GET`/`POST /oauth/authorize`)
- Test: `apps/server/test/oauth-authorize.test.ts`

**Interfaces:**
- Consumes: `resolveClient` (Task 5); `consumeConnectCode`, `createGrant`, `createAuthCode` (Task 1); `AuthLimiter`.
- Produces: `GET /oauth/authorize` (page or error), `POST /oauth/authorize` (form fields: the OAuth parameters as hidden inputs, `code` (the connect code), `save` (checkbox, value `on`)).

Parameter handling (both methods re-validate everything; hidden fields are not trusted):
1. Resolve `client_id`; then `redirect_uri` must be in the client's `redirect_uris` **and** in `ALLOWED_REDIRECTS`. On failure: 400 error page, never a redirect.
2. Then, as redirects to `redirect_uri` with `error` and the original `state`: `response_type` ≠ `code` → `unsupported_response_type`; missing `code_challenge` or `code_challenge_method` ≠ `S256` → `invalid_request`; `resource` present and ≠ resource URL → `invalid_target`.
3. Requested scopes: unknown ones are dropped; the grant gets `hub.read`, plus `hub.save` if the box is ticked, plus `offline_access` if requested.

- [ ] **Step 1: Write the failing tests:**
  - `shows the page`: 200 HTML containing the client name, the text `claude.ai` (redirect host), a code input, and a `save` checkbox that is `checked`.
  - `escapes reflected values`: a DCR client named `<script>alert(1)</script>` appears as `&lt;script&gt;`.
  - `sets a CSP that allows the redirect to Claude`: `Content-Security-Policy` contains `default-src 'none'`, `frame-ancestors 'none'`, and `form-action 'self' https://claude.ai https://claude.com`.
  - `refuses near-miss redirects with an error page, not a redirect`: each of `https://claude.ai/api/mcp/auth_callback/`, `HTTPS://CLAUDE.AI/api/mcp/auth_callback`, `https://claude.ai/api/mcp/auth_callback?x=1`, `http://claude.ai/api/mcp/auth_callback` → 400, no `Location` header.
  - `redirects protocol errors with state`: plain PKCE → 302 to the callback with `error=invalid_request&state=xyz`.
  - `a right code issues an auth code and redirects`: POST → 302 to `https://claude.ai/api/mcp/auth_callback?code=chub_ac_…&state=xyz&iss=https%3A%2F%2Fhub.test`; the grant's scopes are `hub.read hub.save offline_access` (box ticked, offline requested); unticked → no `hub.save`.
  - `a wrong or stale code re-shows the page`: 200 HTML containing `That code is wrong or has expired` and the same hidden `state`, `code_challenge` and `client_id` values; no grant created.
  - `wrong codes are rate-limited by the browser address`: after 10 wrong codes the 11th POST → 429 page; a right code from another address still works.
  - `a used connect code does not work twice`.
- [ ] **Step 2: Run** `…vitest run test/oauth-authorize.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Page copy (exact):
  - Heading: `Connect to context-hub`
  - Body: `<client name> wants to read your project history. After you sign in, you'll be sent back to <redirect host>.`
  - Checkbox label: `Also allow it to save notes to your projects`
  - Code label: `Sign-in code` with hint `Run hub connect on your PC to get one.`
  - Button: `Connect`
  - Wrong code: `That code is wrong or has expired. Run hub connect for a new one.`
  - Error page heading: `This sign-in request can't be used` and the reason in one sentence.
  Page must be usable on a phone (viewport meta, inline CSS only). Read the POST body with the existing size-limited reader and parse `application/x-www-form-urlencoded`.
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the OAuth sign-in page with connect codes"`

### Task 7: The token endpoint

**Files:**
- Create: `apps/server/src/oauth/token.ts`
- Modify: `apps/server/src/oauth/routes.ts` (`POST /oauth/token`)
- Test: `apps/server/test/oauth-token.test.ts`

**Interfaces:**
- Consumes: `takeAuthCode`, `issueTokens`, `findToken`, `rotateRefresh`, `revokePair`, `revokeGrant` (Task 1).
- Produces: `POST /oauth/token` answering `{ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token?, scope }` or `400 { error }`.

Rules: `authorization_code` checks code (single use; reuse revokes the grant), `client_id`, `redirect_uri`, `base64url(sha256(code_verifier)) === code_challenge`, and `resource` if sent. A refresh token is issued only when the grant has `offline_access`. `refresh_token`: unknown, expired, wrong client or revoked grant → `invalid_grant`; already replaced: within 60 s of `replaced_at` → `revokePair(replaced_by)` then issue a fresh pair via `rotateRefresh`; later → `revokeGrant` and `invalid_grant`. None of these count toward the limiter.

- [ ] **Step 1: Write the failing tests:**
  - `exchanges a code with the right verifier`; `refuses a wrong verifier`, `a wrong redirect_uri`, `a wrong client_id`, `a resource that is not the MCP URL`, `an expired code` — each `400 invalid_grant` (or `invalid_target` for resource).
  - `a reused code fails and revokes the grant` — the access token from the first exchange then gets 401 on `/mcp`.
  - `refuses JSON` — `Content-Type: application/json` → `400 invalid_request`.
  - `unsupported grant types` → `400 unsupported_grant_type`.
  - `refresh rotates`: the new pair works on `/mcp`; the old access token keeps working until it expires; the old refresh token used after 61 s → `invalid_grant` and the whole grant is revoked.
  - `racing refreshes within the grace window` (Review Focus 5): refresh with R0 → pair A; refresh with R0 again 10 s later → pair B; pair B's tokens work, pair A's refresh token → `invalid_grant`, and the grant is not revoked.
  - `an idle refresh token expires after 90 days`.
  - `every response has Cache-Control: no-store`.
- [ ] **Step 2: Run** `…vitest run test/oauth-token.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it, then `pnpm test` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the OAuth token endpoint with rotating refresh tokens"`

### Task 8: Grant admin and the full flow

**Files:**
- Modify: `apps/server/src/admin.ts` (`oauth list`, `oauth revoke <id>`), `apps/server/src/main.ts` (read `PUBLIC_URL`, pass `oauth: { publicUrl }` when set, log `oauth: on, <url>` or `oauth: off, no PUBLIC_URL`)
- Test: extend `apps/server/test/admin.test.ts`; create `apps/server/test/e2e-oauth.test.ts`

**Interfaces:**
- Consumes: everything above; the MCP SDK `Client` + `StreamableHTTPClientTransport` as in `e2e.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - admin: `oauth list` prints id, client name, scopes, created and last used for each grant, and nothing secret; `oauth revoke <id>` → its access token gets 401 on `/mcp` immediately; revoking an unknown id fails with a message.
  - e2e, driving the server over real HTTP the way Claude does: unauthenticated `POST /mcp` → 401 with `resource_metadata` → fetch that → fetch AS metadata → `POST /oauth/register` → `GET /oauth/authorize` → `POST` with a connect code from `POST /api/connect-code` → follow the `Location` (do not fetch it; parse `code` and `state`) → `POST /oauth/token` → MCP `Client` with `Authorization: Bearer <access>` calls `list_projects` and gets the project from a session uploaded earlier in the test → refresh → the new access token also works.
- [ ] **Step 2: Run** `…vitest run test/admin.test.ts test/e2e-oauth.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** them, then `pnpm test` and `pnpm typecheck` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add OAuth grant admin and an end-to-end sign-in test"`

### Task 9: Docs, deploy and the real test

**Files:**
- Modify: `README.md` (a "Connect claude.ai" section: add the connector with URL `https://hub.abdulmughnialfikri.com/mcp` and default settings, run `hub connect`, enter the code; revoke with `hub-admin oauth revoke`), `~/project/vps-stack/context-hub/.env.example` (add `PUBLIC_URL=https://hub.abdulmughnialfikri.com` with a one-line comment), the vps-stack runbook's context-hub section (same)

- [ ] **Step 1:** Update the docs. Commit in each repo: `git commit -m "Document connecting claude.ai"` (context-hub) and `git commit -m "Add PUBLIC_URL for context-hub sign-in"` (vps-stack).
- [ ] **Step 2 (owner):** The developer adds `PUBLIC_URL=https://hub.abdulmughnialfikri.com` to `/opt/stack/context-hub/.env` on the server. Then push both repos; pull vps-stack on the server. The context-hub push deploys.
- [ ] **Step 3: Verify the deploy:** the container log shows `oauth: on, https://hub.abdulmughnialfikri.com`; `curl -s https://hub.abdulmughnialfikri.com/.well-known/oauth-protected-resource` returns the resource document; `curl -si -X POST https://hub.abdulmughnialfikri.com/mcp` returns 401 with the `WWW-Authenticate` header; an existing read token still works from Claude Code (`claude mcp list` shows context-hub connected).
- [ ] **Step 4 (owner, manual):** In claude.ai: Customize > Connectors > Add custom connector, URL `https://hub.abdulmughnialfikri.com/mcp`, default settings. Run `hub connect`, enter the code, keep "save notes" ticked. Ask "where did we leave off on jsonroom?" and confirm the answer cites `get_project`. Open the Claude desktop app's chat and Claude mobile and ask again without adding anything. Remove the connector and add it again once (proves a fresh registration). Then `hub-admin oauth list` shows the grants, and revoking the old one leaves the new one working.
- [ ] **Step 5:** Record what the manual test found (pass, or the exact failure) in `docs/superpowers/plans/part5-deviations.md`, along with any deviation from this plan, and commit.
