# Front Door Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live landing page convert better and hold up in public: a way to try the hub on your own computer with no server or domain, answers to the questions a newcomer asks, link previews and search-engine rules, and a small limit on the public form.

**Architecture:** No new moving parts. The landing page (`apps/server/src/web/landing.ts`) gains a FAQ and share metadata, the web router gains `/robots.txt` and a body limit for the waitlist form, and one new Markdown guide explains the local trial using the existing image and commands.

**Tech Stack:** TypeScript on Node 22, `node:http`, better-sqlite3, vitest, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-15-context-hub-front-door-design.md` (its goals and anti-goals still apply). What has already been built and deployed is in `docs/superpowers/plans/front-door-activity.md`.

## Global Constraints

- Branch: the one this worktree is on. One commit per task, with the message the task gives. **No `Co-Authored-By` or other attribution lines.** Do not push, do not open a pull request, do not merge.
- The Content-Security-Policy in `apps/server/src/web/html.ts` is not changed. No inline `<script>`, no `<style>`, no `style=` attribute, nothing loaded from another host.
- With `LANDING` off, signed-out responses stay as they are today. The one new thing is `/robots.txt` (Task 2).
- Nothing a signed-out visitor sees comes from the database.
- The landing page must not say the hosted hub is available.
- Every value that reaches HTML goes through `escapeHtml`.
- Copy given in this plan is used word for word. Plain English, no em dashes.
- `pnpm test` and `pnpm typecheck` pass at the end of every task.
- Do not run `claude mcp add` or change any Claude Code or user configuration on this machine. Do not touch the deployed hub, GitHub settings, or any other repository.
- Where the code differs from what this plan assumed, adapt, keep the intent, and add a line under a new `## Follow-up` heading in `docs/superpowers/plans/front-door-deviations.md`.

## Review Focus

1. A waitlist post with a body over 4,096 bytes: answers 400 with the form, stores nothing, and the server keeps answering. (Task 1)
2. A sign-in post is unaffected by the new limit: a normal code still signs in. (Task 1)
3. `/robots.txt` with `LANDING` off tells crawlers to stay out of everything. (Task 2)
4. Share tags when `PUBLIC_URL` is unset: no `og:url`, `og:image` or canonical link is written, and nothing says `null`. (Task 2)
5. The FAQ renders and opens with scripts disabled, since it is plain `<details>`. (Task 3)

---

### Task 1: A size limit on the waitlist form

**Files:**
- Modify: `apps/server/src/http.ts`, `apps/server/src/web/routes.ts`
- Test: `apps/server/test/web-landing.test.ts`

**Interfaces:**
- Produces: `WebCtx.readBody: (limit?: number) => Promise<Buffer>`; `export const WAITLIST_MAX_BODY = 4096` in `routes.ts`. `readBody` in `http.ts` takes an optional byte limit that replaces `MAX_BODY` for that call and throws the same `HttpError(413, …)` when passed.

- [ ] **Step 1: Write the failing tests** (`post` is the helper already in the file):

```ts
it('refuses a waitlist body over the limit and keeps answering', async () => {
  const res = await post(url, `email=${'a'.repeat(10_000)}%40example.com`);
  expect(res.status).toBe(400);
  expect(await res.text()).toContain('That does not look like an email address.');
  expect(countWaitlist(db)).toBe(0);
  expect((await post(url, 'email=ada%40example.com')).status).toBe(200);
});

it('refuses a gzip-marked waitlist body', async () => {
  const res = await post(url, 'email=ada%40example.com', { 'content-encoding': 'gzip' });
  expect(res.status).toBe(400);
  expect(countWaitlist(db)).toBe(0);
});
```

- [ ] **Step 2: Run** `pnpm vitest run apps/server/test/web-landing.test.ts`; the first new test fails.

- [ ] **Step 3: Implement.** `joinWaitlist` reads with `ctx.readBody(WAITLIST_MAX_BODY)` inside a `try`; any error from reading (too large, bad gzip) answers `sendDocument(res, 400, landingPage('invalid'))`. The limiter call stays before the read, as now. `login` and the signed-in actions keep calling `readBody()` with no limit.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`; all pass, including the existing sign-in tests.

- [ ] **Step 5: Commit.** `git commit -m "Limit the waitlist form's body to 4 KB"`

---

### Task 2: Link previews and robots.txt

**Files:**
- Modify: `apps/server/src/web/html.ts`, `landing.ts`, `routes.ts`
- Test: `apps/server/test/web-landing.test.ts`

**Interfaces:**
- Produces:
  - `head(title: string, extraStyles?: string[], extraHead?: string): string` in `html.ts`; `extraHead` is trusted HTML appended after the stylesheets.
  - `landingPage(note?: WaitlistNote, origin?: string | null): string`; `waitlistThanksPage(): string` unchanged in signature.
  - `robotsTxt(landing: boolean): string` in `landing.ts`.

- [ ] **Step 1: Write the failing tests.** Add a third server to the file's setup, `originUrl`, whose config has `landing: true` and `publicOrigin: 'https://hub.example.com'` (if one already exists for the cross-origin test, reuse it).

```ts
const DESCRIPTION = 'One private briefing per project, written from your Claude Code, Codex and Antigravity sessions. Self-hosted and open source.';

it('carries share tags built from the public address', async () => {
  const html = await (await fetch(`${originUrl}/`)).text();
  expect(html).toContain(`<meta name="description" content="${DESCRIPTION}">`);
  expect(html).toContain('<meta property="og:title" content="context-hub: your AI assistants forget, your hub does not">');
  expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}">`);
  expect(html).toContain('<meta property="og:type" content="website">');
  expect(html).toContain('<meta property="og:url" content="https://hub.example.com/">');
  expect(html).toContain('<meta property="og:image" content="https://hub.example.com/apple-touch-icon.png">');
  expect(html).toContain('<meta name="twitter:card" content="summary">');
  expect(html).toContain('<link rel="canonical" href="https://hub.example.com/">');
});

it('leaves out the address tags when no public address is set', async () => {
  const html = await (await fetch(`${url}/`)).text();
  expect(html).toContain('<meta name="description"');
  expect(html).not.toContain('og:url');
  expect(html).not.toContain('og:image');
  expect(html).not.toContain('rel="canonical"');
  expect(html).not.toContain('null');
});

it('keeps the thank-you page out of search results', async () => {
  const html = await (await post(url, 'email=ada%40example.com')).text();
  expect(html).toContain('<meta name="robots" content="noindex">');
});

it('robots.txt lets crawlers read only the landing page when it is on', async () => {
  const res = await fetch(`${url}/robots.txt`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  expect(await res.text()).toBe('User-agent: *\nAllow: /$\nDisallow: /\n');
});

it('robots.txt keeps crawlers out entirely when the landing page is off', async () => {
  expect(await (await fetch(`${offUrl}/robots.txt`)).text()).toBe('User-agent: *\nDisallow: /\n');
});
```

- [ ] **Step 2: Run** the file and see the new tests fail.

- [ ] **Step 3: Implement.**
  - `head` gains `extraHead`.
  - `landingPage` builds its extra head from the description above, the title it already uses, and, only when `origin` is a string, the `og:url`, `og:image` and canonical tags. Every call site in `routes.ts` passes `ctx.cfg.publicOrigin` as the second argument, including the 400, 429 and 503 answers.
  - `waitlistThanksPage` adds the `noindex` tag.
  - `routes.ts`: in `handleWeb`'s GET branch, before the session lookup, `path === '/robots.txt'` answers 200 with `robotsTxt(ctx.cfg.landing)` as `text/plain; charset=utf-8`, with the same security headers the other answers carry. It needs no session.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`; all pass.

- [ ] **Step 5: Commit.** `git commit -m "Share tags on the landing page and a robots.txt"`

---

### Task 3: Questions and answers on the landing page

**Files:**
- Modify: `apps/server/src/web/landing.ts`, `apps/server/src/web/landing-css.ts`
- Test: `apps/server/test/web-landing.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
it('answers the common questions without any script', async () => {
  const html = await (await fetch(`${url}/`)).text();
  expect(html).toContain('<h2>Questions</h2>');
  expect((html.match(/<details/g) ?? []).length).toBe(5);
  for (const q of ['What gets uploaded?', 'Which assistants does it work with?', 'What does it cost?', 'Can a team share one hub?', 'What if I stop using it?']) {
    expect(html).toContain(`<summary>${q}</summary>`);
  }
  expect(html).not.toMatch(/\sstyle=|<style/);
});
```

- [ ] **Step 2: Run** and see it fail.

- [ ] **Step 3: Implement.** A new `<section id="questions">` between the "Self-host" section and the "Hosted hub" section, holding `<h2>Questions</h2>` and five `<details>` elements, each a `<summary>` and one `<p>`. The copy, word for word:

  | Question | Answer |
  |---|---|
  | What gets uploaded? | Only the projects you say yes to. For each AI session in them, the hub gets the conversation and a short summary of it, with tokens, keys and passwords stripped out first. The files in your repository are not uploaded, unless you add a notes folder yourself. |
  | Which assistants does it work with? | Sessions are collected from Claude Code, Codex and Antigravity. They can then be read from Claude Code, claude.ai, Claude desktop and mobile, or another tool that speaks MCP. |
  | What does it cost? | The software is free. You pay for a small server. Summaries are written by Claude Code on your own computer and count against your Claude plan, so the hub needs no API key. |
  | Can a team share one hub? | Not yet. A hub has no separate users: everyone with access sees everything in it. For now, run one hub per person. |
  | What if I stop using it? | `hub forget <project>` deletes a project from the hub, and removing the server removes everything. The files on your computer are never touched. |

  (`hub forget <project>` is written as `<code>hub forget &lt;project&gt;</code>`.)

  Styles in `landing-css.ts`, using only the existing custom properties: each `details` has a hairline bottom border and vertical padding; `summary` is medium weight with a pointer cursor; the answer is muted. No new colours.

- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`; all pass.

- [ ] **Step 5: Commit.** `git commit -m "Common questions on the landing page"`

---

### Task 4: Try it on your own computer

A newcomer without a server or a domain can run the hub on their own computer in two commands. `PUBLIC_URL` already accepts `http://localhost`, and the install line works against it. The Claude apps cannot reach a hub on `localhost`, so reading is from Claude Code with a read token.

**Files:**
- Create: `docs/try-locally.md`
- Modify: `README.md`, `docs/using.md`, `apps/server/src/web/landing.ts`
- Test: `apps/server/test/web-landing.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
it('points to the try-it-locally guide', async () => {
  const html = await (await fetch(`${url}/`)).text();
  expect(html).toContain('No server yet?');
  expect(html).toContain('href="https://github.com/abdulmuhg/context-hub/blob/main/docs/try-locally.md"');
});
```

- [ ] **Step 2: Run** and see it fail.

- [ ] **Step 3: Check the path really works, with Node instead of Docker.** Build the server and the collector bundle (`pnpm --filter @context-hub/server build`, `pnpm --filter @context-hub/collector build`). In a scratch folder outside the repository, start the server with `PUBLIC_URL=http://localhost:3999`, `PORT=3999`, a scratch `DATABASE_PATH`, and `CLIENT_BUNDLE_PATH` pointing at the built `apps/collector/dist/bin.js`. Then confirm each of these and record the result under `## Follow-up` in the deviations file:
  1. `node apps/server/dist/admin-bin.js setup` (same `DATABASE_PATH` and `PUBLIC_URL`) prints install lines that start with `http://localhost:3999`.
  2. `curl -s http://localhost:3999/install` returns a shell script and `curl -s http://localhost:3999/hub.mjs` returns the bundle.
  3. `admin-bin.js token create --label claude-code --scope read` prints a token, and an MCP `initialize` request to `http://localhost:3999/mcp` with `Authorization: Bearer <token>` answers 200, while the same request without the header answers 401.

  Do not run the install line and do not run `claude mcp add`. Stop the server and delete the scratch folder afterwards. If any of the three fails, do not write the guide as if it worked: describe the failure in the deviations file, and write only the parts that were confirmed.

- [ ] **Step 4: Write `docs/try-locally.md`** ("Try context-hub on your own computer"), about 60 lines, in this order:
  1. One paragraph: what this is for (seeing it work before renting a server), and its two limits: the hub is only reachable from this computer, and claude.ai, the desktop chat and mobile cannot connect to it.
  2. **Start the hub** (needs Docker):

     ```bash
     docker run -d --name context-hub -p 127.0.0.1:3000:3000 -v context_hub_data:/data -e PUBLIC_URL=http://localhost:3000 ghcr.io/abdulmuhg/context-hub:latest
     ```

  3. **Get your codes:** `docker exec context-hub hub-admin setup`, and what it prints. Open `http://localhost:3000/login` with the sign-in code; paste the install line for your system (needs Node 22 or newer).
  4. **Read it from Claude Code:** create a read token with `docker exec context-hub hub-admin token create --label claude-code --scope read`, then add the hub to Claude Code:

     ```bash
     claude mcp add --transport http context-hub http://localhost:3000/mcp --header "Authorization: Bearer <the token>"
     ```

     Then ask "where did we leave off on <project>?" in a new Claude Code session.
  5. **Moving to a real server later:** follow the README's quick start on the server, then paste the new hub's install line on this computer; `hub sync` uploads the same sessions again. Link to `../deploy/README.md`.
  6. **Remove it:** `docker rm -f context-hub` and `docker volume rm context_hub_data`.

- [ ] **Step 5: Link it.**
  - `README.md`: directly under the `## Quick start: self-host` heading's requirements line, add `No server yet? [Try it on your own computer first](docs/try-locally.md).` Add the guide to the `## Docs` list. The README stays at 100 lines or fewer.
  - `landing.ts`: in the self-host section, after the requirements sentence, add `<p>No server yet? <a href="https://github.com/abdulmuhg/context-hub/blob/main/docs/try-locally.md">Try it on your own computer first</a>.</p>`.
  - `docs/using.md`: in the "Which path are you on?" table, the "Hosting the hub, first computer ever" row's source becomes: The server: `docker compose exec context-hub hub-admin setup`, which prints the install line with the code inside.

- [ ] **Step 6: Run** `pnpm test` and `pnpm typecheck`; all pass. Check that every relative link in `README.md`, `docs/try-locally.md` and `docs/using.md` points at a file that exists.

- [ ] **Step 7: Commit.** `git commit -m "Try it locally: guide, and links from the README and landing page"`

---

### Task 5: Final check

- [ ] **Step 1:** `pnpm test` and `pnpm typecheck` from a clean tree; both pass.
- [ ] **Step 2:** `git log --oneline origin/main..HEAD` shows the plan's commits and `git log origin/main..HEAD | grep -i co-authored` prints nothing.
- [ ] **Step 3:** Report, per task: what was built, each deviation, the result of each of Task 4 Step 3's three checks, anything not verified, and the branch name. Do not push.
