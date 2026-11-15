# Front door: short README, landing page, quick self-host, waitlist

Date: 2026-11-15
Status: draft for the owner's review

## Intent

Before a public launch, a stranger should understand context-hub in ten
seconds and be running it in a few minutes. The owner's words: the GitHub
README is **overwhelming**; setup should be **quick whether you self-host or
use mine**; the goal is to **hook people and gain users before launching
publicly**.

## Where things stand today

- `README.md` is 494 lines. The first screen explains three parts and two
  kinds of code. The one-line install is at line 99, after a flowchart and a
  table. There is no picture of the product.
- The hub is single-tenant: no accounts, no per-user data. Anyone given a code
  reads everything. "A hub for more than one person" is parked. So the hosted
  hub cannot take strangers yet.
- Self-hosting needs your own image. `deploy/.env.example` points at
  `ghcr.io/your-name/context-hub:sha-…`, `.github/workflows/deploy.yml` pushes
  only `sha-…` tags, and an anonymous pull of `ghcr.io/abdulmuhg/context-hub`
  answers 403.
- A new hub's first codes come from
  `docker exec context-hub node /app/dist/admin-bin.js device-code` and
  `… connect-code`, two commands the user has to find and tell apart.
- Signed out, `/` redirects to `/login` (`handleWeb` in
  `apps/server/src/web/routes.ts`): a bare code box that says "Run hub connect
  on your PC to get one".
- Pages are server-rendered strings (`apps/server/src/web/html.ts`,
  `pages.ts`) under a strict CSP: no inline script or style, assets from
  `/assets`, fonts from Google Fonts.

## Goals

1. A README a newcomer can read in a minute, ending in one of two actions.
2. Self-host in three commands on a server with Docker and a domain, without
   building an image.
3. A landing page at the reference hub's address that pitches the product,
   shows the self-host quick start, and collects waitlist emails for a hosted
   hub.
4. One command, not two, to get a new hub's first codes.

## Non-goals

- Multi-user hosting. It is its own project; the waitlist measures demand for it.
- A docs site. Reference material stays as Markdown in the repo.
- Changing how sync, summaries or codes work.
- Analytics or any third-party script.

## Anti-goals

- The landing page must not promise a hosted service that does not exist. The
  hosted option is labelled as not open yet.
- A self-hoster's private hub must not show a marketing page or collect
  emails. Their signed-out `/` stays the sign-in screen.
- Nothing shown to a signed-out visitor may reveal what the hub stores.

## Approaches

**A. Self-host first, hosted as a waitlist (chosen by the owner).** Launch on
what works today. Small, honest, and the waitlist says whether multi-user is
worth building.

**B. Build multi-user first.** The hosted button is real at launch, but it
touches the schema, sign-in and every query, and delays everything else.

**C. README only, no landing page.** Cheapest, but the hub's own address stays
a blank sign-in box and there is nowhere to send people or collect interest.

For where the landing page lives, it is served by the hub itself rather than a
separate static site: no second deploy, same domain as the install line, and
the waitlist can use the hub's own SQLite file. This is the builder's call,
not the owner's.

## Design

### 1. README (about 90 lines)

Order:

1. Name, one-sentence pitch, a screenshot.
2. "How it works" in three short lines: sync, summarise locally, ask from any
   assistant.
3. **Quick start: self-host.** The three commands from part 2, then the
   one-line install.
4. **Hosted hub.** One line: not open yet, link to the waitlist.
5. Links: Using the hub, Self-hosting reference, Deploy guide, Contributing,
   Security, License.
6. Status table, trimmed.

Everything else moves, unchanged in wording where possible:

| New file | Takes from the README |
|---|---|
| `docs/using.md` | Claude apps connector, install and login detail, projects and sync, documents, summaries, automatic sync, slash commands, dashboard, sign-in codes, keeping the picture right |
| `docs/self-hosting.md` | Build and run, settings, tokens and admin commands, backups, operate, develop |

The "which path are you on" flowchart and table stay in `docs/using.md`. Any
link in the code or installer that points at a README anchor is updated.

### 2. Self-host in three commands

- `deploy.yml` also pushes `ghcr.io/abdulmuhg/context-hub:latest` and a dated
  version tag next to `sha-…`. The reference server keeps pinning `sha-…`.
- The owner makes the GHCR package public once, in GitHub's package settings.
  This is a manual step outside the repo.
- `deploy/docker-compose.yml` defaults `HUB_IMAGE` to the public `latest`
  image and takes the domain from `.env` (`HUB_DOMAIN`), so the `Caddyfile`
  needs no editing. `PUBLIC_URL` is derived from it. Pinning a tag stays
  documented as the advice for a server you care about.
- The quick start becomes:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/docker-compose.yml -o docker-compose.yml
  echo "HUB_DOMAIN=hub.example.com" > .env
  docker compose up -d
  ```

  (The `Caddyfile` is inlined into the compose file or fetched the same way;
  builder's call.)

### 3. One command for a new hub's first codes

A new admin command, `setup`, prints a sign-in code for the dashboard and the
two install lines (macOS/Linux, Windows) with a computer code inside, the same
lines **Sign-ins > Add a computer** shows. The image gets a `hub-admin` shim so
it is `docker compose exec context-hub hub-admin setup`. `device-code` and
`connect-code` stay.

### 4. Landing page

Shown at `/` to a signed-out visitor **only when `LANDING=on`** (off by
default; the reference hub turns it on). Signed in, `/` is the Overview as
today. With it off, nothing changes.

```
context-hub                                   GitHub   Sign in
----------------------------------------------------------------
Your AI assistants forget. Your hub doesn't.
One private briefing per project, from every Claude Code, Codex
and Antigravity session. Any assistant, any machine, picks up
where the last one stopped.

[ Self-host in 3 commands ]   [ Join the hosted waitlist ]

  > where did we leave off on jsonroom?
  (a short, made-up briefing as the answer)
----------------------------------------------------------------
How it works     1 Sync      2 Summarised on    3 Ask from
                             your computer        anywhere
----------------------------------------------------------------
Private by design   secrets stripped · your server · MIT · no model key
----------------------------------------------------------------
Self-host           the three commands, with a copy button
----------------------------------------------------------------
Hosted hub — not open yet
[ email            ] [ Join waitlist ]
We only use it to tell you when it opens.
----------------------------------------------------------------
GitHub · Docs · Security
```

- Rendered like the other pages: a function in `apps/server/src/web/`, styles
  in the existing stylesheet or a second one under `/assets`, copy buttons in
  the existing script. No inline script or style; the CSP is unchanged.
- Follows the dashboard's light and dark themes.
- The example briefing is invented, never the owner's data.
- The sign-in page's hint is reworded ("Get a code from a connected computer
  with `hub connect`, or from the dashboard") and, when the landing is on,
  links back to it.

### 5. Waitlist

- `POST /waitlist` with one field, `email`. No session needed; it is the
  second action a signed-out browser may post, next to `/login`. Only when
  `LANDING=on`; otherwise 404.
- Checked for same-origin like other forms, rate limited per address with the
  existing limiter, email validated for shape and length.
- Stored in a new table `waitlist (email UNIQUE, created_at)`. A repeat email
  answers the same thank-you page, so the form never says whether an address
  is already listed.
- The owner sees it with `hub-admin waitlist` (list, count) and as a count on
  the Overview page. No email is sent by the hub.
- The page says what the address is used for. The table is in the nightly
  backup like everything else.

## Left to the builder

- Exact copy, within the sketch above. Plain words, no claims the product
  cannot back.
- Whether the landing styles share `app.css` or get their own file.
- How the `Caddyfile` reaches the self-hoster (inlined or fetched).
- The screenshot for the README: taken from the finished landing page.

## For the owner, outside the code

- Make the GHCR package public.
- Set `LANDING=on` in the reference hub's `.env` (in `vps-stack`).
- Point the GitHub repo's "website" field at the hub.
