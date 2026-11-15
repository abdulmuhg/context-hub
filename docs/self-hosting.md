# Self-hosting reference

You need a Linux server with Docker, a domain name pointing at it, and an
HTTPS reverse proxy in front. The hub is one container with one SQLite file
on a volume.

**The quickest route is the [`deploy/`](../deploy) folder:** a ready
`docker-compose.yml` with Caddy (which gets the HTTPS certificate by itself),
a settings template and a nightly backup script, with step-by-step
instructions in [`deploy/README.md`](../deploy/README.md). It runs the public image, so nothing is built.

## Build and run

The repo's `Dockerfile` builds the image and runs the typecheck and the
whole test suite as part of the build:

```bash
docker build -t context-hub .
```

The reference deployment builds it in GitHub Actions
(`.github/workflows/deploy.yml`, which only runs on the original repository),
pushes it to GHCR, and has the server pull it, so the server never builds.

A minimal run without the `deploy/` folder:

```bash
docker run -d --name context-hub \
  -v context_hub_data:/data \
  -e PUBLIC_URL=https://hub.example.com \
  -p 127.0.0.1:3000:3000 \
  context-hub
```

Add `-e ANTHROPIC_API_KEY=...` only if you want the fallback for computers
without Claude Code (see Settings). Point your HTTPS proxy at port 3000. Keep the container off the public
interface; only the proxy should reach it.

## Settings

| Variable | Needed | What it does |
|---|---|---|
| `PUBLIC_URL` | for the Claude apps and the dashboard's secure cookies | The hub's public address, e.g. `https://hub.example.com`. Turns on sign-in for the Claude apps. No path, no trailing slash. With the `deploy/` compose file you do not set it: the file builds it from `HUB_DOMAIN`. |
| `LANDING` | no | `on` shows a public landing page and a waitlist form at `/` to signed-out visitors. Default off: signed-out `/` is the sign-in page. |
| `ANTHROPIC_API_KEY` | no | A fallback only. Computers with Claude Code write their own summaries on your Claude plan, so the hub needs no key. With one set, the hub writes the summaries of sessions that arrive without one (a computer without Claude Code). Billed separately from a Claude subscription. |
| `DIGEST_MODEL` | no | Default `claude-haiku-5-5`. |
| `DIGEST_EFFORT` | no | Default `low`. |
| `DIGEST_DAILY_BUDGET_USD` | no | A daily limit in US dollars for the fallback's summaries (UTC day). When it is reached, they wait until 00:00 UTC; a job already running finishes, so the limit can be passed by one job. |
| `DIGEST_MAX_INPUT_TOKENS` | no | Default `60000`, counted at 2 characters per token so a prompt stays under the 100K-token price step. Long sessions are summarised in parts of this size. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. Default `info`. Logs are one JSON object per line on stdout/stderr; the server refuses to start on any other value. |
| `POSTHOG_KEY` | no | A PostHog project key (`phc_...`). Sends a server-side `$pageview` for each dashboard page: path only (no query string), `app: context-hub`, and a hashed session id as the visitor. Unset means off. |
| `POSTHOG_HOST` | no | PostHog ingest host. Default `https://us.i.posthog.com`. |
| `IMAGE_TAG` | no | Shown on the dashboard as the running version. The reference deploy sets it. |
| `BACKUP_STATUS_PATH` | no | A JSON file the backup job writes; the dashboard shows it. Default `/backup-status/context-hub.json` when it exists. |
| `DATABASE_PATH`, `PORT` | no | Defaults `/data/hub.sqlite` and `3000` in the image. |

## First tokens and first sign-in

There are no accounts. Access is by tokens and one-time codes. On a new hub,
nothing is signed in yet, so the first codes come from the admin command
inside the container. One command prints both:

```bash
docker compose exec context-hub hub-admin setup
```

It prints a sign-in code for the dashboard and the line that connects your
first computer (with its computer code inside), both valid for 10 minutes and
for one use. If you run the container without compose, use
`docker exec context-hub hub-admin setup`.

The two codes are also available one at a time:

```bash
docker compose exec context-hub hub-admin device-code
docker compose exec context-hub hub-admin connect-code
```

- `device-code` connects your first computer: run the installer there and
  enter it in `hub login` (see [Which path are you on?](using.md#which-path-are-you-on)).
- `connect-code` signs in your first browser (the dashboard) or claude.ai.

From then on you rarely need the server: the dashboard's **Sign-ins** page
makes both kinds of code (**Add a computer**, **New sign-in code**), and
lists and disconnects everything.

You can still create long-lived tokens by hand, for example a read token for
an assistant that cannot use the Claude apps' sign-in (it goes in as a bearer
token for `https://hub.example.com/mcp`):

```bash
docker compose exec context-hub hub-admin token create --label claude-code --scope read
```

A token is shown once. `ingest` tokens are for a computer's `hub` command;
`read` tokens are for assistants.

Other admin commands:

```bash
hub-admin setup                       # the first codes and install lines for a new hub
hub-admin token list | token revoke <id>
hub-admin oauth list | oauth revoke <id>
hub-admin device-code | connect-code
hub-admin waitlist                    # emails left on the landing page's waitlist
hub-admin waitlist remove <email>
hub-admin digests
hub-admin redigest <project>
hub-admin redigest --failed [<project>]   # only the failed ones, e.g. after topping up API credit
hub-admin rebuild-state <project>
hub-admin backup <file>
```

Run them as `docker compose exec context-hub hub-admin <command>`.

## Backups

Copying the SQLite file while the server runs is not safe. Use
`hub-admin backup <file>`, which takes a consistent copy. The reference
setup runs a nightly script that does that, keeps 14 days locally, uploads to
S3-compatible storage (one bucket, or two with different providers), and
writes the status file the dashboard reads. Mount only that status folder
into the container, read-only.

## Operate

- **Health:** `GET /healthz` needs no sign-in and answers `{"ok":true,"version":"<sha>"}`, or `503` with `"ok":false` when the SQLite database is unusable. `version` is the commit the image was built from.
- **Gated path:** `GET /api/status` answers `401` without a token. `/` is the dashboard and redirects to `/login` when signed out.
- **State:** `sqlite-volume`: one SQLite file on the `/data` volume, backed up by the stack's `backup-context-hub.sh` (see [Backups](#backups)).
- **Required env:** `PUBLIC_URL` (sign-in and the install script). Everything else is optional; see [Settings](#settings).
- **Logs:** one JSON object per line (`ts`, `level`, `msg`, fields). Each request gets one line with `method`, `path` (no query string), `status`, `ms` and `req_id`, which is also sent back as `X-Request-Id`. Headers, bodies and tokens are never logged. Set `LOG_LEVEL` to change verbosity.
- **Rollback:** set `IMAGE_TAG` in the stack's `.env` to an older `sha-...` tag and run `docker compose pull && docker compose up -d`.

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
```

Run the server locally:

```bash
pnpm --filter @context-hub/server build
DATABASE_PATH=./data/hub.sqlite node apps/server/dist/main.js
```

Designs and plans are in [`docs/superpowers/`](superpowers); see its
README for how to read them.
