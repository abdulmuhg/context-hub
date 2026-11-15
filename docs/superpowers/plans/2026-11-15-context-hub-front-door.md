# Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make context-hub quick to understand and start: a short README, a three-command self-host, one admin command for a new hub's first codes, and an opt-in landing page with a waitlist.

**Architecture:** Everything stays inside the existing server. The landing page and waitlist are two more server-rendered routes in `apps/server/src/web/`, gated by a `LANDING` setting that is off by default. The waitlist is one new SQLite table. Self-host gets simpler through deploy files and CI tags only, with no change to how the hub runs.

**Tech Stack:** TypeScript on Node 22, `node:http`, better-sqlite3, vitest, pnpm workspace, Docker, Caddy, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-15-context-hub-front-door-design.md`

## Global Constraints

- Branch `claude/front-door`. Commit after each task. **No `Co-Authored-By` or other attribution lines in commits.** Do not push and do not open a pull request; the work is reviewed first.
- `LANDING` is off by default. With it off, every existing response is byte-for-byte what it is today, except the sign-in page's reworded hint (Task 4).
- The Content-Security-Policy in `apps/server/src/web/html.ts` is not changed. No inline `<script>`, no inline `style`, no `style=` attributes, nothing loaded from another host.
- No third-party service, script or analytics.
- Nothing a signed-out visitor sees may come from the database, except nothing: the landing page is static text.
- The landing page must not say the hosted hub is available. The words are "not open yet".
- Every value that reaches HTML goes through `escapeHtml`.
- New user-facing wording is plain English: short sentences, no marketing superlatives, no em dashes.
- `pnpm test` and `pnpm typecheck` pass at the end of every task.
- Where the build differs from this plan, add a line saying what and why to `docs/superpowers/plans/front-door-deviations.md` (the repo's convention).

## Review Focus

1. A waitlist post while `LANDING` is off: answers 404 and stores nothing. (Task 5)
2. The same email in different case or with spaces around it: stored once, lowercased. (Task 3)
3. A waitlist post with no `email` field, an empty one, or one longer than 254 characters: answers 400 with the form again, stores nothing, does not throw. (Task 5)
4. Eleven waitlist posts from one address inside five minutes: the eleventh answers 429, and that address can still post to `/login`. (Task 5)
5. A signed-in browser opening `/` while `LANDING` is on: still gets the Overview, not the landing page. (Task 4)
6. `docker compose up` with `HUB_DOMAIN` unset: refuses with a message naming `HUB_DOMAIN`. (Task 1)

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `.github/workflows/deploy.yml` | modify | also push `latest` and the dated version tag |
| `Dockerfile` | modify | `hub-admin` shim on `PATH` |
| `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/README.md` | modify | self-host from the public image with only `HUB_DOMAIN` set |
| `apps/server/src/admin.ts`, `admin-bin.ts` | modify | `setup`, `waitlist`, `waitlist remove` |
| `apps/server/src/db.ts` | modify | one migration: `waitlist` table |
| `apps/server/src/waitlist.ts` | create | normalise, add, list, count, remove |
| `apps/server/src/web/landing.ts` | create | landing page and thank-you page HTML |
| `apps/server/src/web/landing-css.ts` | create | the landing page's stylesheet text |
| `apps/server/src/web/assets.ts` | modify | serve `/assets/landing.css` |
| `apps/server/src/web/html.ts` | modify | optional extra stylesheet in the head; sign-in hint |
| `apps/server/src/web/routes.ts` | modify | `landing` in config, signed-out `/`, `POST /waitlist` |
| `apps/server/src/web/pages.ts` | modify | waitlist count on the Overview |
| `apps/server/src/main.ts`, `http.ts` | modify | read `LANDING`, build the second limiter |
| `README.md` | rewrite | about 90 lines |
| `docs/using.md`, `docs/self-hosting.md` | create | the reference text moved out of the README |

---

### Task 1: Public image tags and a self-host that needs only a domain

**Files:**
- Modify: `.github/workflows/deploy.yml`, `Dockerfile`, `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/README.md`

**Interfaces:**
- Produces: the image `ghcr.io/abdulmuhg/context-hub:latest`; the command `hub-admin` inside the image; the quick-start block below, which Tasks 4 and 6 repeat verbatim.

```bash
mkdir -p context-hub/backups/status && cd context-hub && curl -fsSLO https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/docker-compose.yml -O https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/Caddyfile
echo "HUB_DOMAIN=hub.example.com" > .env
docker compose up -d
```

- [ ] **Step 1: `deploy.yml`.** In the `build-push-action` step, `tags` becomes three lines: the existing `sha-…` tag, `ghcr.io/${{ github.repository }}:latest`, and `ghcr.io/${{ github.repository }}:${{ steps.meta.outputs.version }}`. Nothing else in the workflow changes; the server still deploys the `sha-…` tag.

- [ ] **Step 2: `Dockerfile`.** In the runtime stage, before `USER node`, add an executable `/usr/local/bin/hub-admin` whose whole content is `#!/bin/sh` and `exec node /app/dist/admin-bin.js "$@"`.

- [ ] **Step 3: `deploy/docker-compose.yml`.**
  - `image: ${HUB_IMAGE:-ghcr.io/abdulmuhg/context-hub:latest}`. Replace the comment above it: the default is the public image; set `HUB_IMAGE` in `.env` to pin a tag on a server you care about.
  - Under the hub's `environment`, add `PUBLIC_URL: https://${HUB_DOMAIN:?set HUB_DOMAIN in .env, for example HUB_DOMAIN=hub.example.com}`.
  - Under `caddy`, add `environment:` with `HUB_DOMAIN: ${HUB_DOMAIN}`.

- [ ] **Step 4: `deploy/Caddyfile`.** The site address `hub.example.com` becomes `{$HUB_DOMAIN}`. The opening comment now says the address comes from `HUB_DOMAIN` in `.env` and the file needs no editing. The rest is unchanged.

- [ ] **Step 5: `deploy/.env.example`.** First setting is `HUB_DOMAIN=hub.example.com` with a one-line comment (the hub's DNS name; `PUBLIC_URL` is built from it). `HUB_IMAGE` becomes a commented-out optional line showing a pinned `sha-…` tag. Remove `PUBLIC_URL`. Keep the rest.

- [ ] **Step 6: `deploy/README.md`.** Section 1 becomes the quick-start block above, then the `healthz` check. Section 2 becomes one command, `docker compose exec context-hub hub-admin setup` (Task 2), with one sentence on what it prints. Backups and Updating stay; Updating now says to set `HUB_IMAGE` to pin or `docker compose pull && docker compose up -d` to follow `latest`. Links to the main README's anchors point at `../docs/using.md` instead (Task 6 creates it).

- [ ] **Step 7: Verify.** If Docker is available: in a scratch folder holding the two deploy files, `docker compose config` with no `.env` must fail with a message containing `HUB_DOMAIN`; with `HUB_DOMAIN=hub.test` in `.env` it must print `PUBLIC_URL: https://hub.test` and the default image. If Docker is not available, say so in the deviations file. Run `pnpm test`.

- [ ] **Step 8: Commit.** `git commit -m "Self-host from the public image with only a domain to set"`

---

### Task 2: `hub-admin setup`

**Files:**
- Modify: `apps/server/src/admin.ts`, `apps/server/src/admin-bin.ts`
- Test: `apps/server/test/admin.test.ts`

**Interfaces:**
- Consumes: `createConnectCode(db, now, purpose?)` from `oauth/store.js`; `installLines(hubUrl, code): { unix, windows }` from `client-dist.js`.
- Produces: `AdminIo.publicUrl?: string | null`.

- [ ] **Step 1: Write the failing tests** in a new `describe('hub-admin setup')`:

```ts
it('prints a sign-in code and both install lines carrying a computer code', async () => {
  io.publicUrl = 'https://hub.example.com';
  expect(await runAdmin(['setup'], io)).toBe(0);
  const text = out.join('\n');
  const codes = text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/g)!;
  expect(new Set(codes).size).toBe(2);
  expect(text).toContain('curl -fsSL https://hub.example.com/install | sh -s -- --code ');
  expect(text).toContain("irm https://hub.example.com/install.ps1 | iex");
  expect(text).toContain('https://hub.example.com/login');
  expect(text).toMatch(/10 minutes/);
});

it('without a public address prints both codes and the hub login hint', async () => {
  expect(await runAdmin(['setup'], io)).toBe(0);
  const text = out.join('\n');
  expect(text).toMatch(/Sign-in code: /);
  expect(text).toMatch(/Computer code: /);
  expect(text).toContain('hub login');
  expect(text).not.toContain('curl');
});

it('the sign-in code it prints signs a browser in once', async () => {
  await runAdmin(['setup'], io);
  const code = /Sign-in code: (\S+)/.exec(out.join('\n'))![1]!;
  expect(consumeConnectCode(io.db, code, NOW.toISOString())).toBe(true);
  expect(consumeConnectCode(io.db, code, NOW.toISOString())).toBe(false);
});
```

  If the code format in this repo is not `XXXX-XXXX`, match the format `createConnectCode` produces and note it in the deviations file.

- [ ] **Step 2: Run** `pnpm vitest run apps/server/test/admin.test.ts` and see the three fail.

- [ ] **Step 3: Implement** the `setup` command in `dispatch`, and add its line to `USAGE` (`setup    print the codes and install lines for a new hub's first browser and computer`). Output order: a "1. Open the dashboard" block (the `/login` address when known, then `Sign-in code: …`), a "2. Connect your first computer" block (the two install lines under `macOS / Linux:` and `Windows (PowerShell):`, or `Computer code: …` and the `hub login` hint when there is no address), then one line saying both codes are valid for 10 minutes, for one use. In `admin-bin.ts`, pass `publicUrl: process.env.PUBLIC_URL?.trim() || null`.

- [ ] **Step 4: Run** the test file; all pass. Run `pnpm typecheck`.

- [ ] **Step 5: Commit.** `git commit -m "hub-admin setup: a new hub's first codes in one command"`

---

### Task 3: Waitlist storage and admin commands

**Files:**
- Create: `apps/server/src/waitlist.ts`
- Modify: `apps/server/src/db.ts` (append one migration), `apps/server/src/admin.ts`
- Test: `apps/server/test/waitlist.test.ts`, `apps/server/test/admin.test.ts`, and `apps/server/test/db.test.ts` if it asserts the schema version

**Interfaces:**
- Produces, all from `waitlist.ts`:
  - `export const WAITLIST_MAX = 10_000`
  - `normalizeEmail(raw: string | null): string | null`
  - `addToWaitlist(db: Db, email: string, now: string): 'added' | 'exists' | 'full'` (takes an already-normalised email)
  - `countWaitlist(db: Db): number`
  - `listWaitlist(db: Db): Array<{ email: string; created_at: string }>` (oldest first)
  - `removeFromWaitlist(db: Db, email: string): boolean`

- [ ] **Step 1: Write the failing tests** in `waitlist.test.ts`:

```ts
it('normalises: trims, lowercases, and refuses what is not an address', () => {
  expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
  for (const bad of [null, '', 'ada', 'ada@', '@example.com', 'ada@example', 'a b@example.com', 'a@b@c.com', `${'a'.repeat(250)}@x.co`]) {
    expect(normalizeEmail(bad)).toBeNull();
  }
});

it('stores an address once', () => {
  expect(addToWaitlist(db, 'ada@example.com', NOW)).toBe('added');
  expect(addToWaitlist(db, 'ada@example.com', NOW)).toBe('exists');
  expect(countWaitlist(db)).toBe(1);
  expect(listWaitlist(db)).toEqual([{ email: 'ada@example.com', created_at: NOW }]);
});

it('stops at the limit', () => {
  const insert = db.prepare('INSERT INTO waitlist(email, created_at) VALUES (?, ?)');
  db.transaction(() => { for (let i = 0; i < WAITLIST_MAX; i++) insert.run(`u${i}@example.com`, NOW); })();
  expect(addToWaitlist(db, 'late@example.com', NOW)).toBe('full');
  expect(addToWaitlist(db, 'u1@example.com', NOW)).toBe('exists');
});

it('removes one address', () => {
  addToWaitlist(db, 'ada@example.com', NOW);
  expect(removeFromWaitlist(db, 'ada@example.com')).toBe(true);
  expect(removeFromWaitlist(db, 'ada@example.com')).toBe(false);
});
```

  And in `admin.test.ts`:

```ts
it('waitlist lists addresses with a count, and remove deletes one', async () => {
  addToWaitlist(io.db, 'ada@example.com', NOW.toISOString());
  expect(await runAdmin(['waitlist'], io)).toBe(0);
  expect(out.join('\n')).toContain('ada@example.com');
  expect(out.join('\n')).toMatch(/1 on the waitlist/);
  expect(await runAdmin(['waitlist', 'remove', 'ADA@example.com'], io)).toBe(0);
  expect(countWaitlist(io.db)).toBe(0);
  expect(await runAdmin(['waitlist', 'remove', 'ada@example.com'], io)).toBe(1);
});
```

- [ ] **Step 2: Run** both files and see them fail.

- [ ] **Step 3: Implement.**
  - Migration, appended as the last entry of `MIGRATIONS`: `CREATE TABLE waitlist (email TEXT PRIMARY KEY, created_at TEXT NOT NULL);` with a one-line SQL comment saying what it holds and that it is only written when `LANDING` is on.
  - `normalizeEmail`: trim, lowercase, at most 254 characters, must match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
  - `addToWaitlist`: `exists` is checked before `full`, so a listed address never sees "full".
  - Admin: `waitlist` prints one `created_at(date)  email` line each and a final `N on the waitlist.` (`Nobody is on the waitlist yet.` for none); `waitlist remove <email>` normalises its argument, prints `Removed <email>.`, and fails with `<email> is not on the waitlist.`. Add both to `USAGE`.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`; all pass (update the schema-version assertion in `db.test.ts` if there is one).

- [ ] **Step 5: Commit.** `git commit -m "Waitlist table, store and admin commands"`

---

### Task 4: The landing page

**Files:**
- Create: `apps/server/src/web/landing.ts`, `apps/server/src/web/landing-css.ts`
- Modify: `apps/server/src/web/html.ts`, `assets.ts`, `routes.ts`, `apps/server/src/main.ts`, and wherever tests build a `WebConfig`
- Test: `apps/server/test/web-landing.test.ts`

**Interfaces:**
- Produces:
  - `WebConfig.landing: boolean`
  - `parseLanding(raw: string | undefined): boolean` in `routes.ts`: unset, empty or `off` is false, `on` is true, anything else throws `LANDING must be on or off`. `main.ts` calls it the way it parses `LOG_LEVEL`.
  - `export type WaitlistNote = 'invalid' | 'busy' | 'full'`
  - `landingPage(note?: WaitlistNote): string` and `waitlistThanksPage(): string` in `landing.ts`, each a whole HTML document.
  - `SignInView.landing: boolean`

- [ ] **Step 1: Write the failing tests** in `web-landing.test.ts`. Start the server the way `web-pages.test.ts` does, once with `landing: true` and once with `landing: false`; sign in for the signed-in case the same way that file does.

```ts
it('shows the landing page at / to a signed-out visitor when LANDING is on', async () => {
  const res = await fetch(`${url}/`, { redirect: 'manual' });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('Your AI assistants forget. Your hub does not.');
  expect(html).toContain('docker compose up -d');
  expect(html).toContain('<form method="post" action="/waitlist"');
  expect(html).toContain('not open yet');
  expect(html).toContain('href="/login"');
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  expect(html).not.toMatch(/\sstyle=|<style/);
  expect(res.headers.get('content-security-policy')).toBe(CSP);
});

it('still shows the Overview at / to a signed-in browser', async () => {
  const html = await (await fetch(`${url}/`, { headers: { cookie } })).text();
  expect(html).toContain('<h1>Overview</h1>');
});

it('redirects / to /login when LANDING is off', async () => {
  const res = await fetch(`${offUrl}/`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/login');
});

it('serves the landing stylesheet', async () => {
  const href = /href="(\/assets\/landing\.css[^"]*)"/.exec(await (await fetch(`${url}/`)).text())![1]!;
  const res = await fetch(`${url}${href}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/css/);
});

it('the sign-in page links back to the landing page only when it is on', async () => {
  expect(await (await fetch(`${url}/login`)).text()).toContain('<a href="/">What is context-hub?</a>');
  const off = await (await fetch(`${offUrl}/login`)).text();
  expect(off).not.toContain('What is context-hub?');
  expect(off).toContain('hub connect');
});

it('parseLanding accepts on and off and refuses anything else', () => {
  expect(parseLanding(undefined)).toBe(false);
  expect(parseLanding('off')).toBe(false);
  expect(parseLanding('on')).toBe(true);
  expect(() => parseLanding('yes')).toThrow(/LANDING must be on or off/);
});
```

- [ ] **Step 2: Run** the file and see it fail.

- [ ] **Step 3: `html.ts`.** `head` takes an optional list of extra stylesheet hrefs and is exported. The sign-in page's hint becomes `Get a code from a connected computer with <code>hub connect</code>, or from the dashboard's Sign-ins page.` and, when `landing` is true, the page ends with `<p><a href="/">What is context-hub?</a></p>`. Every caller of `signInPage` passes `landing: ctx.cfg.landing`.

- [ ] **Step 4: `landing-css.ts` and `assets.ts`.** `landing-css.ts` exports the stylesheet as one string, using only the custom properties `app.css` already defines (`--bg`, `--ink`, `--card`, `--hairline`, `--muted`, `--chip`, `--radius`, the two font variables), so both themes work with no new colours. `assets.ts` serves it at `/assets/landing.css` exactly as it serves `app.css`, including `assetHref`'s content hash.

- [ ] **Step 5: `landing.ts`.** One `<main class="landing">` with these sections, in this order, with this copy. Class names are yours.

  - **Top bar:** `context-hub` on the left; on the right `GitHub` (to `https://github.com/abdulmuhg/context-hub`), `Sign in` (to `/login`), and the theme button the dashboard header uses.
  - **Hero:** `<h1>Your AI assistants forget. Your hub does not.</h1>`. Below: `One private briefing per project, written from your Claude Code, Codex and Antigravity sessions. Any assistant, on any computer, picks up where the last one stopped.` Two links styled as buttons: `Self-host in 3 commands` (to `#self-host`, primary) and `Join the hosted waitlist` (to `#waitlist`).
  - **Example**, a card labelled `Example`, mono font, with a made-up exchange:

    ```
    You      where did we leave off on jsonroom?

    Claude   From your hub, last synced 2 hours ago:
             - The share-link expiry bug is fixed and merged.
             - Next: rate limiting on the public API. You chose a
               token bucket per key and had started the tests.
             - Open question: whether free rooms expire after 30 days.
    ```

  - **How it works**, three numbered items: `Sync` / `The hub command finds your AI sessions for the projects you choose.` · `Summarise` / `Claude Code on your own computer writes a short summary. Secrets are stripped before anything is uploaded.` · `Ask` / `Any assistant connected to your hub reads the project's briefing: Claude Code, claude.ai, desktop or mobile.`
  - **Private by design**, four short points: `Runs on your own server.` · `Secrets and card numbers are stripped on your computer, and again on the server.` · `Nothing is uploaded until you say yes to a project.` · `Open source, MIT licensed.`
  - **Self-host** (`id="self-host"`): `<h2>Self-host in 3 commands</h2>`, `You need a Linux server with Docker and a domain name pointing at it.`, then the three lines of Task 1's quick-start block, each as its own copy row using the existing `copyrow` / `copyline` / `copybtn` markup and `data-copy` attribute. Then: `Then run <code>docker compose exec context-hub hub-admin setup</code> for your sign-in code and the line that connects your first computer.` and a link `Full guide` to `https://github.com/abdulmuhg/context-hub/blob/main/deploy/README.md`.
  - **Waitlist** (`id="waitlist"`): `<h2>Hosted hub</h2>`, `A hosted hub, with nothing to run yourself, is not open yet. Leave your email and we will tell you when it is.`, then `<form method="post" action="/waitlist">` with a labelled `type="email"` input named `email` (`required`, `maxlength="254"`, `autocomplete="email"`) and a `Join waitlist` button. Below: `We use your email only to tell you when the hosted hub opens. Ask to be removed at any time.` When a note is passed, a `<p role="alert">` above the form: `invalid` → `That does not look like an email address.`; `busy` → `Too many tries from this address. Try again in 15 minutes.`; `full` → `The waitlist is full right now. Try again later.`
  - **Footer:** links `GitHub`, `Docs` (`…/blob/main/docs/using.md`), `Security` (`…/blob/main/SECURITY.md`).

  `waitlistThanksPage()`: the same top bar, `<h1>You are on the list</h1>`, `We will email you when the hosted hub opens. Until then, you can self-host in three commands.`, and a link back to `/#self-host`. It never shows the address that was entered.

  Layout: one centred column, at most about 760px wide, comfortable at 375px with no horizontal page scroll (code rows scroll inside themselves).

- [ ] **Step 6: `routes.ts`.** In `handleWeb`'s GET branch, before the session check: when `path === '/'`, `ctx.cfg.landing` is true and there is no session, answer `sendDocument(res, 200, landingPage())`. Everything else is unchanged.

- [ ] **Step 7: Run** `pnpm test` and `pnpm typecheck`; all pass.

- [ ] **Step 8: Look at it.** Build and run the server with `LANDING=on` and a scratch `DATABASE_PATH`, open `/` in a browser at desktop width and at 375px, in light and dark. Fix anything that overflows or is unreadable.

- [ ] **Step 9: Commit.** `git commit -m "Landing page at / for signed-out visitors when LANDING is on"`

---

### Task 5: The waitlist form

**Files:**
- Modify: `apps/server/src/web/routes.ts`, `apps/server/src/web/pages.ts`, `apps/server/src/http.ts` (or wherever `WebCtx` is built)
- Test: `apps/server/test/web-landing.test.ts`, `apps/server/test/web-overview.test.ts`

**Interfaces:**
- Consumes: Task 3's `normalizeEmail`, `addToWaitlist`, `countWaitlist`; Task 4's `landingPage`, `waitlistThanksPage`, `WaitlistNote`.
- Produces: `WebCtx.waitlistLimiter: AuthLimiter`, a second instance, so waitlist posts never count against sign-in.

- [ ] **Step 1: Write the failing tests.** `post(base, body, headers?)` posts `application/x-www-form-urlencoded` with `redirect: 'manual'`.

```ts
it('stores a new address, lowercased, and thanks the visitor', async () => {
  const res = await post(url, 'email=%20Ada%40Example.com%20');
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('You are on the list');
  expect(html).not.toContain('ada@example.com');
  expect(listWaitlist(db).map((r) => r.email)).toEqual(['ada@example.com']);
});

it('answers a repeat exactly like a first time', async () => {
  const first = await (await post(url, 'email=ada%40example.com')).text();
  const again = await post(url, 'email=ada%40example.com');
  expect(again.status).toBe(200);
  expect(await again.text()).toBe(first);
  expect(countWaitlist(db)).toBe(1);
});

it.each(['', 'email=', 'email=nope', `email=${'a'.repeat(300)}%40x.co`, 'other=1'])('refuses %j with the form again', async (body) => {
  const res = await post(url, body);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('That does not look like an email address.');
  expect(countWaitlist(db)).toBe(0);
});

it('is a 404 that stores nothing when LANDING is off', async () => {
  expect((await post(offUrl, 'email=ada%40example.com')).status).toBe(404);
  expect(countWaitlist(offDb)).toBe(0);
});

it('refuses a post from another origin', async () => {
  // this server is started with publicOrigin set to its own address
  expect((await post(originUrl, 'email=ada%40example.com', { origin: 'https://evil.example' })).status).toBe(403);
});

it('blocks the eleventh post in five minutes, without blocking sign-in', async () => {
  for (let i = 0; i < 10; i++) await post(url, `email=u${i}%40example.com`);
  const res = await post(url, 'email=u10%40example.com');
  expect(res.status).toBe(429);
  expect(await res.text()).toContain('Too many tries from this address.');
  expect(countWaitlist(db)).toBe(10);
  const login = await fetch(`${url}/login`, { method: 'POST', body: 'code=WRONG', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  expect(login.status).toBe(200);
});
```

  In `web-overview.test.ts`:

```ts
it('shows the waitlist count on the Overview only when LANDING is on', async () => {
  addToWaitlist(db, 'ada@example.com', NOW);
  expect(overviewPage(db, { ...cfg, landing: true }, NOW, 'csrf')).toContain('Waitlist: 1');
  expect(overviewPage(db, { ...cfg, landing: false }, NOW, 'csrf')).not.toContain('Waitlist');
});
```

- [ ] **Step 2: Run** and see them fail.

- [ ] **Step 3: Implement `POST /waitlist`** in `handleWeb`'s POST branch, next to `/login` and before the session check. Order: `landing` off → `return false` (the caller's 404); `originAllowed` fails → `forbiddenPage`; `waitlistLimiter.isBlocked(address)` → 429 `landingPage('busy')`; `waitlistLimiter.recordFailure(address)` for every post that gets this far (every try counts, not only bad ones); read the form; `normalizeEmail` null → 400 `landingPage('invalid')`; `addToWaitlist` → `full` is 503 `landingPage('full')`, `added` and `exists` are both 200 `waitlistThanksPage()`. Build the second `AuthLimiter` where the first is built and add it to `WebCtx`.

- [ ] **Step 4: Overview.** When `cfg.landing` is true, add `<p class="footnote">Waitlist: N</p>` beside the version footnote, where N is `countWaitlist(db)`.

- [ ] **Step 5: Run** `pnpm test` and `pnpm typecheck`; all pass.

- [ ] **Step 6: Try it.** With the server from Task 4 Step 8 running, submit the form with a good address, a bad one, and the same good one again, then check `node apps/server/dist/admin-bin.js waitlist` against the same database.

- [ ] **Step 7: Commit.** `git commit -m "Waitlist form on the landing page"`

---

### Task 6: Short README, reference moved to docs

**Files:**
- Rewrite: `README.md`
- Create: `docs/using.md`, `docs/self-hosting.md`
- Modify: any file that links to a README anchor (find them with a search for `README` and `#which-path`, `#sign-in-codes`, `#settings`, `#backups` across `apps/`, `packages/`, `integrations/`, `deploy/`, `CONTRIBUTING.md`, `SECURITY.md`)

- [ ] **Step 1: Move, do not rewrite.** Copy the current README's text into the two new files with its wording intact, fixing only heading levels and links:
  - `docs/using.md` ("Using a hub"): everything under "Use an existing hub", in its current order, including both diagrams, "Sign-in codes" and "Keeping the hub's picture right".
  - `docs/self-hosting.md` ("Self-hosting reference"): "Build and run", "Settings" (add a `LANDING` row: `no`, `on` shows a public landing page and waitlist form at `/` to signed-out visitors; default off; and replace the `PUBLIC_URL` advice for `deploy/` users with a note that the compose file builds it from `HUB_DOMAIN`), "First tokens and first sign-in" (lead with `hub-admin setup`; the `node /app/dist/admin-bin.js` spellings become `hub-admin`), admin commands (add `setup`, `waitlist`, `waitlist remove <email>`), "Backups", "Operate", "Develop".

- [ ] **Step 2: Write the new `README.md`,** at most 100 lines, in this order:
  1. `# context-hub`, then the pitch: `Your AI assistants forget. Your hub does not.` and the two-sentence description from the landing hero.
  2. The example exchange from Task 4 Step 5 in a fenced block.
  3. `## How it works`: the three items from the landing page as a numbered list.
  4. `## Quick start: self-host`: one line of requirements, Task 1's quick-start block, then `docker compose exec context-hub hub-admin setup` and one sentence on what it prints and what the pasted line does (installs `hub`, connects the computer, asks which projects to upload, runs the first sync). Then one sentence on adding the connector in claude.ai with a link to `docs/using.md`.
  5. `## Hosted hub`: `Not open yet.` and a link to `https://hub.abdulmughnialfikri.com/#waitlist`.
  6. `## Docs`: a list linking `docs/using.md`, `docs/self-hosting.md`, `deploy/README.md`, `docs/superpowers/`.
  7. `## Status`: the existing table, unchanged.
  8. `## Contributing` (the existing three sentences) and `## License`.

  No screenshot yet: one is added during review, once the landing page is live to capture.

- [ ] **Step 3: Fix links.** Update every link found by the search to its new home. Run the search again for `README.md#` and confirm none is left dangling.

- [ ] **Step 4: Check.** `wc -l README.md` is 100 or less. Every relative link in the three files points at a file that exists. `pnpm test` passes (some tests assert on link text in `cli.ts` or `mcp.ts`; update them with the code).

- [ ] **Step 5: Commit.** `git commit -m "Short README; reference moved to docs/"`

---

### Task 7: Final check

- [ ] **Step 1:** `pnpm test` and `pnpm typecheck` from a clean tree; both pass.
- [ ] **Step 2:** `git log --oneline main..HEAD` shows one commit per task and no attribution trailers (`git log main..HEAD | grep -i co-authored` prints nothing).
- [ ] **Step 3:** Report: what was built per task, every entry in `front-door-deviations.md`, anything that could not be verified (for example Docker not available), and the branch name. Do not push.
