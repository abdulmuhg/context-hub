# Part 5 deviations and deferred items

Branch `part5-oauth`. Plan: `2026-10-20-context-hub-part5-oauth.md`. Everything below was found while building; nothing here was fixed outside the plan's scope unless marked "fixed".

## Scope

Tasks 1 to 8 and Task 9 Step 1 (README) are done. Task 9 Steps 2 to 5 (`PUBLIC_URL` on the server, pushing, deploy checks, the manual claude.ai test) and the vps-stack changes were not done. They belong to the owner. **Step 5 has nothing to record yet: the manual claude.ai test has not been run.**

## Deviations from the plan

| # | Task | Deviation | Reason |
|---|---|---|---|
| D1 | 1 | `digest-store.test.ts`: the schema-version assertion is now `>= 3`, and its "upgrade from version 1" test also drops the five OAuth tables. | Migration 4 would otherwise fail with "table already exists" when the test replays migrations 2 to 4. |
| D2 | 1 | Two extra indexes on `oauth_tokens` (`pair_hash`, `grant_id`). | Lookups by pair and by grant. No behaviour change. |
| D3 | 2 | Two existing `http.test.ts` tests that said "a valid token from a blocked address gets 429" now probe with an unknown token. | The Task 2 rule reverses that behaviour on purpose. The tests' intent (429 after 10 failures, first `X-Forwarded-For` hop) is kept. |
| D4 | 2 | OAuth access tokens are accepted on `/mcp` only. On `/api/*` they get 403. | The plan grants OAuth tokens `/mcp` only. |
| D5 | 2 | A malformed but non-empty `Authorization` header still counts as a failed login. Only an absent header is free. | Unchanged existing behaviour. The plan only exempts "no header". |
| D6 | 3 | `hub-admin connect-code` prints "Valid until <ISO time>, for one use. …" instead of "Valid for 10 minutes …". | The plan fixes exact text only for `hub connect`. |
| D7 | 4 | `send()` in `http.ts` is exported and imported by `oauth/routes.ts`. This is a circular import. | Later routes need the same body-draining `send`. It only runs at request time, so it is safe now. |
| D8 | 5 | `OAuthConfig` has an optional `lookup` function for DNS. | A seam so tests never touch real DNS. It defaults to `dns.lookup` with `all: true`. |
| D9 | 5 | `POST /oauth/register` reads the request with its own 64 KiB cap. | `ctx.readBody` allows 20 MB. |
| D10 | 5 | A `client_id` starting `http://` goes through the CIMD path and is refused there. | Same result as refusing it up front. |
| D11 | 7 | `store.ts` `rotateRefresh` no longer expires the access token paired with the old refresh token. One line removed. | It contradicted the required test "the old access token keeps working until it expires". Theft handling is unaffected: `revokePair` still kills the paired access token on a grace retry, and late reuse revokes the whole grant. |
| D12 | 9 | The README implementer first edited the Status line to say all five parts are deployed. Reverted in a later commit. | Part 5 is not merged or deployed. |

Fixed in the final review wave: README status made accurate (and a no-trailing-slash note for the connector URL); `PUBLIC_URL` is now validated at startup (`parsePublicUrl`: https, or http on localhost only; no path, query, fragment or userinfo); legacy bearer tokens that happen to start with `chub_at_` or `chub_rt_` (about 1 in 262,000) are no longer rejected as unknown OAuth tokens.

Fixed during review, inside the plan's scope: the IPv4-mapped IPv6 SSRF gap in the client fetch check (Task 5); the declined "save notes" choice being re-ticked after a wrong code, and the client fetch running before the limiter (Task 6); an unreadable token request body escaping without `no-store` (Task 7).

## Deferred, outside the plan

**Security-relevant**
- `GET /oauth/authorize` with a CIMD `client_id` still triggers an outbound fetch per request. Failed fetches are not cached. The 3 s timeout, no redirects and the private-address block limit the damage, but the volume is unlimited. (Task 6)
- DNS rebinding: the private-address check and the fetch resolve the name separately. Redirects are off and the body must be JSON with `client_id` equal to its URL, so it is a blind GET only. The DNS lookup also sits outside the 3 s timeout. (Task 5)
- `POST /oauth/register` has no rate limit, and `redirect_uris` is not de-duplicated or capped, so one request can store about 64 KB. CIMD rows are never pruned. (Task 5)
- The failed-login limiter keys on `X-Forwarded-For` (existing behaviour). Wrong-code limiting on the sign-in page is only as good as Caddy overwriting that header. (Task 6)
- The resolver's reason text ("private or unresolvable address", "not JSON", …) is shown to anonymous callers on the error page. It is a small probing oracle. (Task 6)
- Non-443 ports are allowed for CIMD URLs. `privateV4` omits TEST-NET and `198.18.0.0/15`. (Task 5)

**Raised by the final review, deliberately not changed (each needs a decision or goes beyond the plan)**
- A hub-issued expired or revoked token (`'dead'`) sent from an address that is already blocked gets 429 instead of 401 with `WWW-Authenticate`. This is the order the plan specifies (blocked before dead). On a shared egress address, one stranger sending made-up tokens could stall the owner's connector for 15 minutes until the block lapses. The fix would be to check `isBlocked` only inside the unknown-token branch. Worth deciding before relying on it.
- `/mcp/` (trailing slash) answers 404 with no challenge, so a connector added with that URL never starts discovery. The README now says to use the URL exactly as written.
- CIMD fetch uses `redirect: 'manual'` and needs a plain 200. If Anthropic's client metadata URL ever redirects, sign-in fails at the authorize page and DCR does not take over. The manual test must cover this.
- `/.well-known/oauth-authorization-server` is served at the bare path only (correct for an issuer without a path). Mirroring the `/mcp`-suffixed form would be cheap insurance.
- `POST /api/connect-code` works even when `PUBLIC_URL` is unset, so `hub connect` hands out codes that nothing can use.
- A retried lost response to the first token exchange will fail with `invalid_grant` and revoke the grant (code reuse). Expect one possible "sign-in failed, try again" during the manual test.

**Refresh-token design (from the spec's rules, implemented faithfully)**
- Inside the 60 s grace window, a stolen old refresh token can replace the real client's pair. The real client's next use of the dead pair gets `invalid_grant` without revoking the grant, so the theft goes unnoticed and the attacker's pair gets a fresh 90-day idle life.
- `revokePair(replaced_by)` does not cascade. In the chain R0 → R1 → R2', replaying R0 inside its grace window kills only R1 and leaves R2' alive.
- The authorization code is consumed before client, redirect and verifier checks. A failed attempt burns it and a legitimate retry then revokes the grant. Codes are 256-bit, so this is a denial-of-service at worst.
- Grace is measured from the first rotation, and exactly 60 s counts as late.

**Minor**
- `takeAuthCode` does a SELECT then an UPDATE rather than one conditional UPDATE. `rotateRefresh` does not check the token kind, replaced state or expiry. `findToken` does not filter expiry or revocation, so every caller must. (Task 1)
- Metadata URL in `http.ts` is built by slicing `/mcp` off the resource URL. `verifyToken` is now used only by tests. (Task 2)
- Several limiter tests assert "not 429" rather than the exact status. No test checks that `touchGrant` is skipped on a 403. (Task 2)
- No route-level test that a connect code lands in the DB, or that a valid call is not counted by the limiter. `hub-admin connect-code` prints a raw ISO time. (Task 3)
- `http.ts` and `oauth/routes.ts` import each other. Moving `send` to a leaf module would fix it. (Task 4)
- `code_challenge` format and length (43 to 128 base64url characters) is not validated at `/oauth/authorize`. `base()` is duplicated in `authorize.ts`. A stale comment sits near `authorize.ts:60`. (Task 6)
- Raw SQL for the grant lookup in `token.ts`. Scope is built differently on the code path and the refresh path. `reply()` duplicates the `json()` helper. (Task 7)
- The e2e test does not assert that discovered endpoints share the server's origin, or that the refresh token is dead after `oauth revoke`. `oauth list` prints client names raw. (Task 8)
- `task-1-report.md` (git-ignored scratch) still describes the old `rotateRefresh` behaviour.

## Manual test (Task 9 Step 4/5)

Not run. Nothing was deployed or pushed.

## Owner review fixes (2026-10-20)

Applied after the branch was handed back, each with a test:

- **Stale tokens from a blocked address get 401, not 429.** A hub-issued token that has expired or been revoked now answers 401 with the `WWW-Authenticate` challenge even when the address is blocked, so Claude refreshes instead of stalling. Only unknown tokens see the block and count. This closes the first item under "Raised by the final review".
- **Client ID Metadata Documents are fetched only from `https://claude.ai` and `https://claude.com`**, the origins of the allowed redirects, as Anthropic's lazy-authentication guide suggests. This removes the arbitrary outbound fetch from anonymous `GET /oauth/authorize`, and with it the deferred fetch-volume, DNS-rebinding and non-443-port concerns. The private-address checks stay as a second layer.
- **The sign-in page names a CIMD client by its host** (`claude.ai`), not by the document's self-chosen `client_name`, also per that guide.
- **At most 100 unused DCR clients are kept**, newest first, so unauthenticated registration cannot grow the table without bound. (DCR redirect URIs were already limited to the two allowed values.)

Still deferred, accepted for now: a lost response to the first code exchange makes the retry revoke the grant (sign in again); the grace-window theft caveats; `/mcp/` with a trailing slash; connect codes issued while `PUBLIC_URL` is unset; and the minor items above.
