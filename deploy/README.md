# Deploying context-hub

A working single-server setup: the hub behind Caddy, which gets the HTTPS
certificate by itself, plus a nightly backup script.

| File | What it is |
|---|---|
| `docker-compose.yml` | The hub and Caddy |
| `Caddyfile` | HTTPS and headers for your hub's address |
| `.env.example` | The hub's settings; copy to `.env` |
| `backup.sh` | A consistent nightly backup, with optional off-site upload |

## 1. Set up

On a Linux server with Docker, with your hub's DNS name pointing at it:

```bash
mkdir -p ~/context-hub && cd ~/context-hub
# copy the four files from this folder here, then:
cp .env.example .env              # fill in HUB_IMAGE, PUBLIC_URL, ANTHROPIC_API_KEY
mkdir -p backups/status           # before the first start, so it is not owned by root
nano Caddyfile                    # replace hub.example.com
docker compose up -d
```

Check it: `curl https://hub.example.com/healthz` answers `{"status":"ok"}`.

## 2. Connect your first computer and browser

Nothing is signed in on a new hub, so the first codes come from the server:

```bash
docker compose exec context-hub node /app/dist/admin-bin.js device-code    # for hub login on your computer
docker compose exec context-hub node /app/dist/admin-bin.js connect-code   # for the dashboard or claude.ai
```

Then follow the main [README](../README.md#which-path-are-you-on). After that,
the dashboard's **Sign-ins** page makes both kinds of code.

## 3. Back up every night

Copying the SQLite file while the hub runs is not safe; `backup.sh` takes a
consistent copy through the hub's own admin command, keeps 14 days locally,
and writes the status file the dashboard shows.

```bash
crontab -e
# 30 3 * * * /home/you/context-hub/backup.sh >> /home/you/context-hub/backups/backup.log 2>&1
```

For an off-site copy to any S3-compatible storage (Cloudflare R2, Backblaze
B2, S3), create `.env.backup` next to the script, readable only by you
(`chmod 600 .env.backup`):

```
S3_BUCKET=your-bucket
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

Old off-site copies are not deleted by the script; set a lifecycle rule (for
example, delete after 30 days) on the bucket.

## Updating

Change `HUB_IMAGE` in `.env` to the new tag, then `docker compose up -d`.
The database migrates itself on start. Take a backup first.
