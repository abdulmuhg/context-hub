# context-hub Part 4: Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to work through this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **This plan is not suited to unattended execution.** Phase C acts on a real GitHub account, real DNS and a production server; every step there is marked with who runs it and must not be run without the owner's go-ahead in the conversation.

**Goal:** Run the context-hub server on the VPS at `https://hub.abdulmughnialfikri.com`, deployed from CI like `job-engine`, with a nightly backup, and connect the collector and one assistant to it.

**Architecture:** Nothing new is designed here. The work follows "Adding another app" in `~/project/vps-stack\README.md`, which is the authority; where this plan and that runbook disagree, the runbook wins and this plan is corrected. The app repo gains a `Dockerfile` and a deploy workflow. The `vps-stack` repo gains a compose file, an env example, two Caddy site blocks, a network and a backup script. The server holds one stateful thing for this app: a SQLite file in a Docker volume.

**Tech Stack:** Docker (multi-stage, `node:22-slim`), GitHub Actions, GHCR, Docker Compose, Caddy 2, cron.

**Spec:** `docs/superpowers/specs/2026-10-10-context-hub-design.md` — section 10.

## Plan series

| Part | Delivers | Status |
|---|---|---|
| 1 | `packages/core` and the `hub` collector | Merged |
| 2 | Server: storage, ingest API, tokens, search, MCP lookup tools | Merged |
| 3 | Digests and project state pages | Merged |
| 4 (this file) | Image, deploy workflow, `vps-stack` changes, backup, go-live | Ready |

## Who does what

Every step is tagged.

- **[agent]** — safe to do without asking: edits files in the two local repos, builds and runs a container on this PC.
- **[agent, after go-ahead]** — changes something outside this PC (GitHub, the VPS). The agent states exactly what it is about to run and waits for a yes in the conversation. One yes covers one step.
- **[owner]** — only the owner does this. It involves a secret (API key, SSH private key, token) or an account the agent must not act on (DNS registrar). The agent never reads, prints or types these values.

## Global Constraints

- Two repos are edited: `~/project/context-hub` (branch `part4-deploy`) and `~/project/vps-stack` (branch `add-context-hub`). Do not commit to `main` in either until the owner says to merge.
- **Commit messages carry no `Co-Authored-By` line and no other attribution trailer**, in both repos.
- Never commit a real `.env`. `vps-stack`'s `.gitignore` allows only `*.env.example`.
- Hostnames go in `edge/Caddyfile` in git and are never edited on the server.
- On the server: `docker compose` only, never `docker build` (the one exception is the runbook's own: a throwaway test build from a tarball in `/tmp`, deleted afterwards, and only if CI is unavailable).
- The compose service uses `expose`, never `ports`. The service name `context-hub` must be unique on the machine.
- Every service has a `mem_limit`. This one: `256m`.
- Network name: `edge-hub`. Primary hostname: `hub.abdulmughnialfikri.com`. Redirecting hostname: `hub.hanadul.site`.
- The container listens on port `3000` and stores its database at `/data/hub.sqlite`.
- Both DNS records must resolve to `<server-ip>` **before** Caddy is recreated. A failed certificate challenge can lock the hostname out for a week.
- After any Caddyfile change the Caddy container is **recreated**, not reloaded (the runbook explains why a reload silently keeps the old file).
- Ask before anything destructive. Nothing in this plan needs `docker compose down -v`; do not run it.
- Never claim the deploy worked without the full verification list in Task 9.

## Review Focus

1. **The image builds but the native SQLite module is missing or built for the wrong platform:** the image build itself must fail, not the live container. Task 1.
2. **The database volume is not writable by the unprivileged user:** the container must start and write on a fresh volume. Task 1.
3. **A client-supplied `X-Forwarded-For` header reaches the app:** the failed-login limiter would then count the wrong address. Caddy must replace it. Task 9.
4. **A backup that is empty or was taken mid-write:** the script must fail loudly, and a restore must be tried once by hand. Tasks 4 and 10.
5. **The first real model call is rejected** (model id, effort, output format): digests would all fail. Checked on one small session before the full backfill. Task 11.

---

## Phase A — the app repo (no outside effects)

### Task 1: Dockerfile [agent]

**Files:**
- Create: `~/project/context-hub\Dockerfile`
- Create: `~/project/context-hub\.dockerignore`

- [ ] **Step 1: Create the branch**

```bash
cd ~/project/context-hub
git checkout -b part4-deploy
```

- [ ] **Step 2: Write `.dockerignore`**

```
# Built inside the image. Host copies would bloat the context and could ship
# Windows native binaries into a Linux image.
node_modules
**/node_modules
dist
**/dist
.pnpm-store

# Never in an image.
.env
.env.*
!.env.example
data
*.sqlite
*.sqlite-*

.git
.superpowers
docs
```

- [ ] **Step 3: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

# Build for linux/amd64, the VPS's platform. better-sqlite3 is a native module;
# an image built for another platform starts and then dies on first query.

# ---------------------------------------------------------------------------
# Stage 1: build and test
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Matches the pnpm major that wrote pnpm-lock.yaml.
RUN npm install -g pnpm@11

COPY . .
RUN pnpm install --frozen-lockfile

# Both gates run before anything ships, so a regression fails the build
# instead of reaching the server. There is no separate test job in CI.
RUN pnpm run typecheck
RUN pnpm test

RUN pnpm --filter @context-hub/server build

# A self-contained copy of the server with production dependencies only,
# real files instead of pnpm's symlinks. --legacy keeps the pre-pnpm-10
# behaviour, which needs no workspace injection settings.
RUN pnpm --filter @context-hub/server deploy --prod --legacy /runtime \
 && cp -r apps/server/dist /runtime/dist

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/package.json ./package.json
COPY --from=build /runtime/dist ./dist

# Fail the image build, not the live container, if the native module is
# missing, built for the wrong platform, or lacks full-text search.
RUN node -e "import('better-sqlite3').then((m) => { const d = new m.default(':memory:'); d.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); d.close(); })"

# The database lives on a volume. Create the mount point owned by the
# unprivileged user first; a new named volume copies that ownership.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV PORT=3000
ENV DATABASE_PATH=/data/hub.sqlite
EXPOSE 3000

USER node
CMD ["node", "--enable-source-maps", "/app/dist/main.js"]
```

- [ ] **Step 4: Build it**

Run: `docker build --platform linux/amd64 -t context-hub:local .`
Expected: the build finishes. The test step inside it prints `Tests  437 passed` (or more), and the native-module check runs without error.

If `pnpm install` fails on `better-sqlite3` because no prebuilt binary could be downloaded, add this line before `RUN pnpm install` in the build stage only, and rebuild:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
```

If `pnpm deploy` rejects `--legacy`, remove the flag and add `inject-workspace-packages=true` to a new `.npmrc` at the repo root; rebuild. Record whichever change was needed in `docs/superpowers/plans/part4-deviations.md`.

If Docker Desktop is not running, start it and retry. If it cannot be started, skip Steps 4 to 6, say so plainly in the final report, and rely on the CI build in Task 8.

- [ ] **Step 5: Run it on a fresh volume and check it writes as the unprivileged user**

```bash
docker volume create context-hub-test
docker run -d --name context-hub-test -p 127.0.0.1:3919:3000 -v context-hub-test:/data context-hub:local
sleep 2
docker logs context-hub-test
curl -s http://127.0.0.1:3919/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3919/api/status
docker exec context-hub-test id -un
docker exec context-hub-test ls -l /data
```

Expected, in order: the log lines `digests: off, no ANTHROPIC_API_KEY…` and `context-hub listening on :3000, database /data/hub.sqlite`; `{"status":"ok"}`; `401`; `node`; a listing that includes `hub.sqlite` owned by `node`.

- [ ] **Step 6: Check `hub-admin` and a backup work inside the container, then clean up**

```bash
docker exec context-hub-test node /app/dist/admin-bin.js token list
docker exec context-hub-test node /app/dist/admin-bin.js backup /tmp/check.sqlite
docker exec context-hub-test ls -l /tmp/check.sqlite
docker rm -f context-hub-test
docker volume rm context-hub-test
```

Expected: `No tokens yet.`; `Backup written to /tmp/check.sqlite`; a non-empty file. Do not create a token in this step.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "Add Dockerfile for the server"
```

---

### Task 2: Deploy workflow [agent]

**Files:**
- Create: `~/project/context-hub\.github\workflows\deploy.yml`

- [ ] **Step 1: Write the workflow**

Copied from `job-application-engine/.github/workflows/deploy.yml` with two changes: the `cd` path, and the trigger is manual only until one run is green (the runbook requires this order).

```yaml
name: Deploy

# Manual only for now. The push trigger is added in the last task, after one
# manual run has gone green against a provisioned server. A push trigger
# against a half-provisioned server fails every commit with an opaque SSH error.
on:
  workflow_dispatch:

# Two deploys racing would leave IMAGE_TAG and the running container
# disagreeing. Queue instead of cancelling.
concurrency:
  group: deploy-main
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4

      - id: meta
        run: echo "tag=sha-${GITHUB_SHA::12}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # The Dockerfile runs the typecheck and the whole test suite before
      # bundling. That is the correctness gate; there is no separate test job.
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ steps.meta.outputs.tag }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          script: |
            set -euo pipefail
            cd /opt/stack/context-hub
            # Rewrite the pinned tag, then pull. Rollback is the same edit
            # with an older SHA.
            sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${{ needs.build.outputs.tag }}|" .env
            grep '^IMAGE_TAG=' .env
            docker compose pull
            docker compose up -d
            docker image prune -f
```

- [ ] **Step 2: Check it is valid YAML**

Run: `node -e "const y=require('node:fs').readFileSync('.github/workflows/deploy.yml','utf8'); if(!/workflow_dispatch:/.test(y)||/^\s+push:/m.test(y)) process.exit(1); console.log('manual trigger only: ok')"`
Expected: `manual trigger only: ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "Add deploy workflow, manual trigger only"
```

---

## Phase B — the `vps-stack` repo (files only, nothing deployed)

### Task 3: Compose file, env example, network and Caddy [agent]

**Files:**
- Create: `~/project/vps-stack\context-hub\docker-compose.yml`
- Create: `~/project/vps-stack\context-hub\.env.example`
- Modify: `~/project/vps-stack\edge\docker-compose.yml`
- Modify: `~/project/vps-stack\edge\Caddyfile`

- [ ] **Step 1: Create the branch**

```bash
cd ~/project/vps-stack
git status --short        # must print nothing; if it does, stop and ask the owner
git checkout -b add-context-hub
```

- [ ] **Step 2: Write `context-hub/docker-compose.yml`**

```yaml
# No build context. CI builds this image and pushes it to GHCR; the server
# only pulls.
services:
  context-hub:
    # Pinned by commit SHA, never :latest. Rollback is editing IMAGE_TAG in
    # .env back to a previous SHA and running `docker compose up -d`.
    image: ghcr.io/abdulmuhg/context-hub:${IMAGE_TAG:?IMAGE_TAG must be set in .env}
    restart: unless-stopped
    # No `ports:`. Reachable only through Caddy.
    expose:
      - "3000"
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: "3000"
      DATABASE_PATH: /data/hub.sqlite
    volumes:
      # The only state this app has: one SQLite file. Unlike job-engine, this
      # container is NOT disposable. scripts/backup-context-hub.sh covers it.
      - context_hub_data:/data
    networks:
      - edge-hub
    mem_limit: 256m
    healthcheck:
      # node:22-slim ships no curl or wget, so probe with Node's own fetch.
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

volumes:
  context_hub_data:

networks:
  edge-hub:
    external: true
```

- [ ] **Step 3: Write `context-hub/.env.example`**

```
# Copy to .env on the server and fill in. Never commit the result.

# Set by CI on every deploy. Seed it with any pushed SHA to bootstrap.
IMAGE_TAG=sha-000000000000

# Writes the session digests and project state pages. Without it the server
# still runs: uploads and lookups work, and digests wait in a queue.
# Create at console.anthropic.com. Billed separately from a Claude subscription.
ANTHROPIC_API_KEY=sk-ant-...

# Optional. These are the defaults.
# DIGEST_MODEL=claude-haiku-5-5
# DIGEST_EFFORT=low
# DIGEST_MAX_INPUT_TOKENS=80000

# There is no app-level access key here on purpose. Access is by tokens stored
# (hashed) in the database. Create them on the server with:
#   docker compose exec context-hub node /app/dist/admin-bin.js token create --label <name> --scope <ingest|read>
```

- [ ] **Step 4: Add the network to `edge/docker-compose.yml` in both places**

Under `services.caddy.networks`, after `- edge-n8n`, add:

```yaml
      - edge-hub
```

Under the top-level `networks:` at the bottom, after the `edge-n8n` block, add:

```yaml
  edge-hub:
    external: true
```

Also extend the comment above that block so the creation command lists all three:

```yaml
#   docker network create edge-jobs && docker network create edge-n8n && docker network create edge-hub
```

Missing the second place is the common mistake the runbook warns about; compose then fails with "network not found".

- [ ] **Step 5: Add two site blocks to the end of `edge/Caddyfile`**

Use tabs for indentation, as the rest of the file does.

```
hub.abdulmughnialfikri.com {
	# No `encode gzip`: the lookup endpoint streams server-sent events, and the
	# upload endpoint already receives gzip from the collector.

	# A digest lookup is quick, but an upload of a long session can take a
	# while on a slow link.
	reverse_proxy context-hub:3000 {
		transport http {
			read_timeout 300s
			write_timeout 300s
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
	}
}

# Second name for the same hub. Tools are configured with one address, and the
# browser login planned for chat apps needs one fixed address, so this only
# redirects. 308 keeps the method and body.
hub.hanadul.site {
	redir https://hub.abdulmughnialfikri.com{uri} 308
}
```

- [ ] **Step 6: Check both compose files parse**

```bash
cd ~/project/vps-stack
IMAGE_TAG=sha-test docker compose -f context-hub/docker-compose.yml --env-file context-hub/.env.example config --quiet && echo "context-hub compose: ok"
docker compose -f edge/docker-compose.yml config --quiet && echo "edge compose: ok"
docker run --rm -v "$(pwd)/edge/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Expected: `context-hub compose: ok`, `edge compose: ok`, and Caddy printing `Valid configuration`. The Caddy check only parses the file; it requests no certificates.

- [ ] **Step 7: Commit**

```bash
git add context-hub/docker-compose.yml context-hub/.env.example edge/docker-compose.yml edge/Caddyfile
git commit -m "Add context-hub: compose file, env example, network and hostnames"
```

---

### Task 4: Backup script [agent]

**Files:**
- Create: `~/project/vps-stack\scripts\backup-context-hub.sh`

- [ ] **Step 1: Write the script**

Modelled on `scripts/backup-n8n.sh`: same variables, same emptiness check, same optional off-box copy, same retention.

```bash
#!/usr/bin/env bash
# Nightly context-hub backup.
#
# context-hub keeps everything in one SQLite file inside a Docker volume: the
# uploaded conversations, their digests, the project state pages and the access
# tokens (hashed). Conversations from this PC can be uploaded again, and digests
# can be regenerated at a cost, so a lost volume is recoverable but slow and not
# free. This script makes it a restore instead.
#
# The copy is taken with SQLite's online backup, through the app's own admin
# command, so it is consistent even while the server is writing. Copying the
# file out of the volume directly is NOT safe while the server runs.
set -euo pipefail

STACK_DIR="${STACK_DIR:-/opt/stack}"
BACKUP_DIR="${BACKUP_DIR:-${STACK_DIR}/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="${BACKUP_DIR}/context-hub-${STAMP}.sqlite.gz"
COMPOSE=(docker compose -f "${STACK_DIR}/context-hub/docker-compose.yml")
INSIDE="/tmp/hub-backup.sqlite"

mkdir -p "${BACKUP_DIR}"

"${COMPOSE[@]}" exec -T context-hub rm -f "${INSIDE}"
"${COMPOSE[@]}" exec -T context-hub node /app/dist/admin-bin.js backup "${INSIDE}"
"${COMPOSE[@]}" exec -T context-hub cat "${INSIDE}" | gzip -9 > "${DUMP}"
"${COMPOSE[@]}" exec -T context-hub rm -f "${INSIDE}"

# A zero-length or truncated backup is worse than none, because it looks like
# a backup exists. Fail loudly instead.
if [ ! -s "${DUMP}" ]; then
  echo "FATAL: backup ${DUMP} is empty" >&2
  rm -f "${DUMP}"
  exit 1
fi
if ! gzip -t "${DUMP}"; then
  echo "FATAL: backup ${DUMP} is not a valid gzip file" >&2
  exit 1
fi
# Every SQLite file starts with this 15-byte header.
if [ "$(gunzip -c "${DUMP}" | head -c 15)" != "SQLite format 3" ]; then
  echo "FATAL: backup ${DUMP} is not a SQLite database" >&2
  exit 1
fi

echo "wrote ${DUMP} ($(du -h "${DUMP}" | cut -f1))"

# Optional off-box copy, same variables as backup-n8n.sh. Skipped entirely
# when S3_BUCKET is unset.
if [ -n "${S3_BUCKET:-}" ]; then
  docker run --rm \
    -e AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:?S3_ACCESS_KEY required when S3_BUCKET is set}" \
    -e AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:?S3_SECRET_KEY required when S3_BUCKET is set}" \
    -v "${BACKUP_DIR}:/backups:ro" \
    amazon/aws-cli:latest \
    --endpoint-url "${S3_ENDPOINT:?S3_ENDPOINT required when S3_BUCKET is set}" \
    s3 cp "/backups/$(basename "${DUMP}")" "s3://${S3_BUCKET}/context-hub/"
  echo "uploaded to s3://${S3_BUCKET}/context-hub/"
fi

find "${BACKUP_DIR}" -name 'context-hub-*.sqlite.gz' -mtime "+${RETENTION_DAYS}" -delete
echo "pruned local backups older than ${RETENTION_DAYS} days"
```

- [ ] **Step 2: Mark it executable in git and check its syntax**

```bash
cd ~/project/vps-stack
bash -n scripts/backup-context-hub.sh && echo "syntax: ok"
git add scripts/backup-context-hub.sh
git update-index --chmod=+x scripts/backup-context-hub.sh
git ls-files -s scripts/backup-context-hub.sh scripts/backup-n8n.sh
```

Expected: `syntax: ok`, and both scripts listed with mode `100755`. If `backup-n8n.sh` shows `100644`, leave it alone and mention it in the final report; do not change another app's file.

- [ ] **Step 3: Try the script against the local test image**

This proves the script end to end without touching the server. It needs the `context-hub:local` image from Task 1; skip this step if that build was skipped.

```bash
cd ~/project/vps-stack
TMP="$(mktemp -d)"
mkdir -p "${TMP}/context-hub"
cat > "${TMP}/context-hub/docker-compose.yml" <<'EOF'
services:
  context-hub:
    image: context-hub:local
    volumes:
      - backup_test_data:/data
volumes:
  backup_test_data:
EOF
docker compose -f "${TMP}/context-hub/docker-compose.yml" up -d
sleep 2
STACK_DIR="${TMP}" bash scripts/backup-context-hub.sh
ls -l "${TMP}/backups/"
gunzip -c "${TMP}"/backups/context-hub-*.sqlite.gz | head -c 15; echo
docker compose -f "${TMP}/context-hub/docker-compose.yml" down -v
rm -rf "${TMP}"
```

Expected: `wrote …context-hub-<stamp>.sqlite.gz`, one non-empty file listed, and `SQLite format 3`. The `down -v` here removes only this step's own throwaway volume.

- [ ] **Step 4: Commit**

```bash
git commit -m "Add nightly backup script for context-hub"
```

---

### Task 5: Update the runbook [agent]

**Files:**
- Modify: `~/project/vps-stack\README.md`
- Modify: `~/project/vps-stack\CLAUDE.md`

The runbook says `README.md` wins and that both files must stay correct. Make these edits; keep the existing wording style.

- [ ] **Step 1: `README.md`**

1. In the opening paragraph, change "Two unrelated projects share this machine" to "Three unrelated projects share this machine" and add **context-hub** (private archive of AI assistant conversations, served to assistants over MCP) to the list.
2. In both directory trees, add a line: `  context-hub/  pulls ghcr.io image pinned by IMAGE_TAG; SQLite in a volume`, and list `backup-context-hub.sh` beside `backup-n8n.sh`.
3. In the "Current state" table, add a row. Until Task 9 passes, write it as planned, not live:
   `| context-hub | planned: https://hub.abdulmughnialfikri.com (hub.hanadul.site redirects) |`
4. In "First-time setup" step 5, add `docker network create edge-hub`.
5. Under "Routine operations", add:

```markdown
**Deploy context-hub:** run the Deploy workflow in the `context-hub` repo (or
push to `main` once the push trigger is enabled).

**Create or revoke an access token:**

    cd /opt/stack/context-hub
    docker compose exec context-hub node /app/dist/admin-bin.js token create --label <name> --scope <ingest|read>
    docker compose exec context-hub node /app/dist/admin-bin.js token list
    docker compose exec context-hub node /app/dist/admin-bin.js token revoke <id>

A token is shown once. `ingest` is for the collector, `read` for an assistant.

**See digest problems:**

    docker compose exec context-hub node /app/dist/admin-bin.js digests
```

6. Under "If you lose the server", add:

```markdown
- **context-hub:** restore the newest backup into the volume before starting
  the container:

      gunzip -c backups/context-hub-<stamp>.sqlite.gz > /tmp/hub.sqlite
      docker compose -f context-hub/docker-compose.yml run --rm --no-deps -T \
        --entrypoint sh context-hub -c 'rm -f /data/hub.sqlite-wal /data/hub.sqlite-shm; cat > /data/hub.sqlite' < /tmp/hub.sqlite
      rm /tmp/hub.sqlite
      docker compose -f context-hub/docker-compose.yml up -d

  Without a backup: start empty, create new tokens, and run `hub sync` on the
  PC again. Conversations come back; digests are regenerated and billed again.
```

7. In "Capacity", update the committed-memory estimate by 256 MB.

- [ ] **Step 2: `CLAUDE.md`**

1. Add `context-hub/` and `backup-context-hub.sh` to the stack tree.
2. In "State and what is disposable", replace the sentence "**n8n is the only stateful thing on the machine.**" with a version that names both, and add a bullet:

```markdown
- **context-hub is stateful too.** One SQLite file in the `context_hub_data`
  volume holds the uploaded conversations, digests and access tokens. It is
  recoverable without a backup (re-sync from the PC, re-pay for digests) but
  slow. `scripts/backup-context-hub.sh` runs nightly. Copying the file out of
  the volume while the server runs is not a safe backup; the script uses
  SQLite's online backup through the app's admin command.
```

3. In "Verifying a change", note that context-hub's health path is `/healthz` and its gated path is `/api/status`.

- [ ] **Step 3: Commit**

```bash
cd ~/project/vps-stack
git add README.md CLAUDE.md
git commit -m "Document context-hub in the runbook"
```

**Stop here.** Phases A and B are complete and nothing outside this PC has changed. Report what was built and wait for the owner before Phase C.

---

## Phase C — go-live (every step needs the owner)

Work through these in order. Each is verifiable before the next depends on it.

### Task 6: Publish the app repo and its deploy secrets

- [ ] **Step 1 [owner, optional]: Remove the old co-author lines before the first push**

Twenty-three early commits on `main` carry `Co-Authored-By` lines. They are local only until the first push. To remove them, the owner runs this once, on `main`, before Step 2:

```bash
cd ~/project/context-hub
git checkout main
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter "sed '/^Co-Authored-By:/d'" -- --all
git log --format=%B | grep -c "^Co-Authored-By:"     # expect 0
```

This rewrites every commit hash, which is harmless before the first push and must not be done after it. Skip this step to keep the history as it is.

- [ ] **Step 2 [agent, after go-ahead]: Merge the deploy branch and create the private repository**

```bash
cd ~/project/context-hub
git checkout main && git merge --ff-only part4-deploy
gh repo create abdulmuhg/context-hub --private --source . --remote origin --push
gh repo view abdulmuhg/context-hub --json visibility,defaultBranchRef --jq '.visibility, .defaultBranchRef.name'
```

Expected: `PRIVATE` and `main`. If Step 1 was run after branches were created, re-create `part4-deploy` from the rewritten `main` first.

- [ ] **Step 3 [owner]: Add the three deploy secrets**

The owner runs these. The third reads the private deploy key from disk straight into GitHub; nothing is printed.

```bash
gh secret set SSH_HOST --repo abdulmuhg/context-hub --body "<server-ip>"
gh secret set SSH_USER --repo abdulmuhg/context-hub --body "ubuntu"
gh secret set SSH_KEY  --repo abdulmuhg/context-hub < "$USERPROFILE/.ssh/vps_deploy"
gh secret list --repo abdulmuhg/context-hub
```

Expected: three names listed. The same deploy key serves every repo; do not create a new one.

### Task 7: Prepare DNS and the server

- [ ] **Step 1 [owner]: Create both DNS records**

At each domain's registrar, add an `A` record for `hub` pointing to `<server-ip>`: one on `abdulmughnialfikri.com`, one on `hanadul.site`.

- [ ] **Step 2 [agent]: Confirm both resolve before going further**

```bash
nslookup hub.abdulmughnialfikri.com 1.1.1.1
nslookup hub.hanadul.site 1.1.1.1
```

Expected: each answers `<server-ip>`. If either does not, stop. Do not continue to Step 5 until both do; a failed certificate challenge can cost a week.

- [ ] **Step 3 [agent, after go-ahead]: Publish the `vps-stack` changes**

```bash
cd ~/project/vps-stack
git checkout main && git merge --ff-only add-context-hub && git push
```

- [ ] **Step 4 [agent, after go-ahead]: Create the network and pull the config on the server**

```bash
ssh ubuntu@<server-ip> 'docker network create edge-hub && cd /opt/stack && git pull --ff-only && ls context-hub'
```

Expected: a network id, a fast-forward, and `docker-compose.yml` listed.

- [ ] **Step 5 [owner]: Create the server's `.env` with the API key**

The owner does this over SSH, in a real terminal:

```bash
ssh ubuntu@<server-ip>
cd /opt/stack/context-hub
cp .env.example .env && chmod 600 .env
nano .env        # paste the Anthropic API key; leave IMAGE_TAG as it is
```

Save the key in a password manager as well. To go live without digests first, leave `ANTHROPIC_API_KEY` commented out; the server runs and queues them.

- [ ] **Step 6 [agent, after go-ahead]: Recreate Caddy so it joins the new network and loads the new hostnames**

```bash
ssh ubuntu@<server-ip> 'cd /opt/stack && docker compose -f edge/docker-compose.yml up -d --force-recreate caddy && sleep 5 && docker compose -f edge/docker-compose.yml exec -T caddy cat /etc/caddy/Caddyfile | grep -c "hub.abdulmughnialfikri.com"'
```

Expected: `1`. Recreating drops the other two sites for a few seconds; say so before running it. Then watch certificates being issued:

```bash
ssh ubuntu@<server-ip> 'cd /opt/stack && docker compose -f edge/docker-compose.yml logs --since 2m caddy | grep -i -E "certificate obtained|error" | tail -20'
```

Expected: `certificate obtained successfully` for both new hostnames and no errors. Until Task 8 deploys the app, `https://hub.abdulmughnialfikri.com` answers 502; that is expected.

Confirm the existing sites still work:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://plainfit.hanadul.site/api/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://n8n.hanadul.site/
```

Expected: `200` for both.

### Task 8: First deploy

- [ ] **Step 1 [agent, after go-ahead]: Run the workflow by hand and watch it**

```bash
gh workflow run Deploy --repo abdulmuhg/context-hub
sleep 5
gh run watch --repo abdulmuhg/context-hub "$(gh run list --repo abdulmuhg/context-hub --workflow Deploy --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: both jobs green. If `build` fails, the cause is in the Dockerfile or a test; read the log, fix it on a branch, and run again. If `deploy` fails and `build` passed, the cause is SSH: check the three secrets and that the deploy key is in the server's `authorized_keys`.

### Task 9: Verify — every item, not a subset

- [ ] **Step 1 [agent]: The runbook's four checks**

```bash
ssh ubuntu@<server-ip> "docker ps --format 'table {{.Names}}\t{{.Status}}' && grep '^IMAGE_TAG=' /opt/stack/context-hub/.env"
curl -s https://hub.abdulmughnialfikri.com/healthz
curl -s -o /dev/null -w '%{http_code}\n' https://hub.abdulmughnialfikri.com/api/status
```

Expected: a `context-hub` container shown as `healthy`; a real `sha-` tag, not the seed zeros; `{"status":"ok"}`; `401`.

- [ ] **Step 2 [agent]: The redirect, and plain HTTP**

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://hub.hanadul.site/healthz
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://hub.abdulmughnialfikri.com/healthz
```

Expected: `308 https://hub.abdulmughnialfikri.com/healthz`, then a `308` to the `https://` address.

- [ ] **Step 3 [agent]: Caddy replaces a forged `X-Forwarded-For` (Review Focus 3)**

Send ten failed logins that all claim to come from a made-up address, then one more without the header:

```bash
for i in $(seq 1 10); do curl -s -o /dev/null -H "Authorization: Bearer chub_wrong" -H "X-Forwarded-For: 203.0.113.77" https://hub.abdulmughnialfikri.com/api/status; done
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer chub_wrong" https://hub.abdulmughnialfikri.com/api/status
```

Expected: `429`. That proves the limiter counted this PC's real address, so Caddy discarded the forged header. If it prints `401`, the forged header reached the app: stop and fix the Caddy site block with `header_up X-Forwarded-For {remote_host}` inside `reverse_proxy`, recreate Caddy, and repeat. Note that this PC's address is now blocked for 15 minutes; wait before Task 10, or restart the container to clear it:

```bash
ssh ubuntu@<server-ip> 'cd /opt/stack/context-hub && docker compose restart context-hub'
```

- [ ] **Step 4 [agent]: The log shows the expected start-up lines**

```bash
ssh ubuntu@<server-ip> 'cd /opt/stack/context-hub && docker compose logs --tail 20 context-hub'
```

Expected: `context-hub listening on :3000, database /data/hub.sqlite`, and either `digests: on, model claude-haiku-5-5, effort low` or `digests: off…`, matching what the owner put in `.env`. No stack traces.

- [ ] **Step 5 [agent, after go-ahead]: Mark it live in the runbook**

In `vps-stack/README.md`, change the "Current state" row from `planned:` to the live address with today's date, then commit and push `vps-stack`.

### Task 10: Backup, proven once by hand

- [ ] **Step 1 [agent, after go-ahead]: Run the script once and look at the result**

```bash
ssh ubuntu@<server-ip> '/opt/stack/scripts/backup-context-hub.sh && ls -lh /opt/stack/backups/ | grep context-hub'
```

Expected: `wrote …`, and a non-empty `context-hub-<stamp>.sqlite.gz`.

- [ ] **Step 2 [agent, after go-ahead]: Prove the backup opens (Review Focus 4)**

A backup nobody has opened is not a backup. This restores into a throwaway container, not the live volume:

```bash
ssh ubuntu@<server-ip> 'cd /opt/stack && F=$(ls -t backups/context-hub-*.sqlite.gz | head -1) && gunzip -c "$F" > /tmp/restore-check.sqlite && docker run --rm -v /tmp/restore-check.sqlite:/check.sqlite:ro --entrypoint node ghcr.io/abdulmuhg/context-hub:$(grep "^IMAGE_TAG=" context-hub/.env | cut -d= -f2) -e "import(\"better-sqlite3\").then((m)=>{const d=new m.default(\"/check.sqlite\",{readonly:true});console.log(d.pragma(\"integrity_check\",{simple:true}), d.pragma(\"user_version\",{simple:true}))})"; rm -f /tmp/restore-check.sqlite'
```

Expected: `ok 3` (integrity check passed, schema version 3).

- [ ] **Step 3 [agent, after go-ahead]: Schedule it nightly**

```bash
ssh ubuntu@<server-ip> '(crontab -l 2>/dev/null; echo "30 3 * * * /opt/stack/scripts/backup-context-hub.sh >> /opt/stack/backups/backup.log 2>&1") | crontab - && crontab -l'
```

Expected: both the n8n line (03:15) and the new line (03:30) listed, each once.

### Task 11: Connect the collector and one assistant

- [ ] **Step 1 [owner]: Create two tokens**

The owner runs these on the server and copies each token as it is shown. It is shown once.

```bash
ssh ubuntu@<server-ip>
cd /opt/stack/context-hub
docker compose exec context-hub node /app/dist/admin-bin.js token create --label collector-pc --scope ingest
docker compose exec context-hub node /app/dist/admin-bin.js token create --label claude-code-pc --scope read
```

- [ ] **Step 2 [agent, after go-ahead]: Install the `hub` command on this PC**

```bash
cd ~/project/context-hub
pnpm --filter @context-hub/collector build
cd apps/collector && pnpm link --global
hub projects | head -5
```

Expected: a list of the projects on this PC, none tracked.

- [ ] **Step 3 [owner]: Point the collector at the hub**

```bash
hub init
```

Enter `https://hub.abdulmughnialfikri.com` and paste the **ingest** token at the prompt. Use the prompt, not the `--token` flag, so the token does not land in shell history.

- [ ] **Step 4 [owner]: Track one small project and look before sending**

```bash
hub projects
hub track <one small project>
hub sync --dry-run
```

Read the dry-run output: which sessions would be sent, how many secrets would be stripped, and any personal data found. Add personal values to filter with `hub personal add <label>`, and raise the level with `hub personal level list partial` or `full`, before the first real sync. With the default level `warn`, found values are uploaded unchanged.

- [ ] **Step 5 [owner]: First real sync, one project**

```bash
hub sync
hub status
```

Expected: `Uploaded N sessions`, and `hub status` showing the same number of sessions with digests `pending` or already `ok`.

- [ ] **Step 6 [agent, after go-ahead]: Check the first real digests (Review Focus 5)**

```bash
ssh ubuntu@<server-ip> 'cd /opt/stack/context-hub && sleep 30 && docker compose exec -T context-hub node /app/dist/admin-bin.js digests && docker compose logs --tail 30 context-hub | grep -i -E "digest|state"'
```

Expected: `ok` counts rising, `failed: 0`, `refused: 0`. If every digest failed with the same error, the model call is being rejected. Read the error in the output, fix it in `apps/server/src/llm-anthropic.ts` on a branch with a test, deploy, and run `hub-admin redigest <project>`. Do not track more projects until one digest has succeeded.

- [ ] **Step 7 [owner]: Connect Claude Code**

```bash
claude mcp add --transport http context-hub https://hub.abdulmughnialfikri.com/mcp --header "Authorization: Bearer <paste the read token>"
```

Then, in a new Claude Code session, ask: "Where did we leave off on <the project you tracked>?" The assistant should call `get_project` and answer from the state page and digests.

- [ ] **Step 8 [owner]: Read two digests against the conversations they came from**

Open two sessions through the assistant ("show me the digest and then the conversation for the latest session") and judge whether the digest is accurate and useful. The prompts in `llm-anthropic.ts` are a first version; this is the first chance to tune them. Note what is wrong before tracking the rest.

- [ ] **Step 9 [owner]: Track the remaining projects**

```bash
hub track <project>      # repeat
hub sync --dry-run
hub sync
```

This is the backfill. Sessions are digested one at a time, oldest first.

- [ ] **Step 10 [owner, optional]: Install the slash command**

```bash
cp ~/project/context-hub/integrations/claude-code/hub-sync.md ~/.claude/commands/
```

### Task 12: Turn on automatic deploys

Only now, with one green manual run and everything in Task 9 verified.

- [ ] **Step 1 [agent, after go-ahead]: Add the push trigger**

In `~/project/context-hub\.github\workflows\deploy.yml`, replace the `on:` block and its comment with:

```yaml
# Every commit to main deploys. Enabled after a manual dispatch went green
# against a provisioned server; workflow_dispatch is kept for redeploying an
# unchanged tree and for rollback testing.
on:
  push:
    branches: [main]
  workflow_dispatch:
```

```bash
cd ~/project/context-hub
git add .github/workflows/deploy.yml
git commit -m "Deploy on every push to main"
git push
gh run watch --repo abdulmuhg/context-hub "$(gh run list --repo abdulmuhg/context-hub --workflow Deploy --limit 1 --json databaseId --jq '.[0].databaseId')"
```

That commit is itself the first automatic deploy, which makes it the test. Expected: green, and `curl -s https://hub.abdulmughnialfikri.com/healthz` still answers `{"status":"ok"}` afterwards.

- [ ] **Step 2 [agent]: Update the app README**

Replace the `## Status` paragraph in `README.md` with: `All four parts are built and deployed at https://hub.abdulmughnialfikri.com.` Commit and push. This triggers one more deploy; confirm it goes green.

---

## Rollback

The same as every app on this server:

```bash
ssh ubuntu@<server-ip>
cd /opt/stack/context-hub
sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=sha-<previous>|' .env
docker compose pull && docker compose up -d
```

A newer image may have run a database migration that an older image does not know. Migrations here only add tables and rows, so an older image still starts; it ignores what it does not use. If a future migration changes an existing table, restore the backup taken before that deploy instead of only changing the tag.

## What is still not built

- **Browser login for chat apps** (claude.ai, ChatGPT, Gemini), the `save` tool, and importers for chat-app exports. These are the spec's second build.
- **A dashboard.** Discussed and deferred; it would share the browser login.
- **Off-box backup copies.** The script supports S3-compatible storage through the same variables as the n8n script, but none is configured.
