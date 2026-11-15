# Deploying context-hub

A working single-server setup: the hub behind Caddy, which gets the HTTPS
certificate by itself, plus a nightly backup script.

| File | What it is |
|---|---|
| `docker-compose.yml` | The hub and Caddy |
| `Caddyfile` | HTTPS and headers; the address comes from `HUB_DOMAIN` |
| `.env.example` | The hub's settings; the quick start below needs only `HUB_DOMAIN` |
| `backup.sh` | A consistent nightly backup, with optional off-site upload |

## 1. Set up

On a Linux server with Docker, with your hub's DNS name pointing at it:

```bash
mkdir -p context-hub/backups/status && cd context-hub && curl -fsSLO https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/docker-compose.yml -O https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/Caddyfile
echo "HUB_DOMAIN=hub.example.com" > .env
docker compose up -d
```

The compose file runs the public image and builds `PUBLIC_URL` from
`HUB_DOMAIN`. Other settings (for example `ANTHROPIC_API_KEY`, which is
optional) are listed in `.env.example`.

Check it: `curl https://hub.example.com/healthz` answers `{"ok":true,"version":"<sha>"}`.

## 2. Connect your first computer and browser

Nothing is signed in on a new hub, so the first codes come from the server:

```bash
docker compose exec context-hub hub-admin setup
```

It prints a sign-in code for the dashboard and the line that connects your
first computer, both valid for 10 minutes and for one use.

Then follow [Using a hub](../docs/using.md). After that, the dashboard's
**Sign-ins** page makes both kinds of code.

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

`S3_REGION` is optional and defaults to `auto`, which suits R2; other providers
may want their own region name. To keep a second copy with another provider,
add the same settings again with an `S3_SECONDARY_` prefix
(`S3_SECONDARY_BUCKET`, `S3_SECONDARY_ENDPOINT` and so on). Each backup then
goes to both buckets, each upload is attempted even when the other fails, and
the dashboard shows the off-site copy as OK only when both landed.

Old off-site copies are not deleted by the script; set a lifecycle rule (for
example, delete after 30 days) on each bucket.

## Updating

To follow `latest`: `docker compose pull && docker compose up -d`. To pin a
version, set `HUB_IMAGE` in `.env` to a tag (for example
`ghcr.io/abdulmuhg/context-hub:sha-0123456789ab`), then `docker compose up -d`.
The database migrates itself on start. Take a backup first.
