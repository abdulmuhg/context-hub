# context-hub

Your AI assistants forget. Your hub does not.

One private briefing per project, written from your Claude Code, Codex and
Antigravity sessions. Any assistant, on any computer, picks up where the last
one stopped.

```
You      where did we leave off on jsonroom?

Claude   From your hub, last synced 2 hours ago:
         - The share-link expiry bug is fixed and merged.
         - Next: rate limiting on the public API. You chose a
           token bucket per key and had started the tests.
         - Open question: whether free rooms expire after 30 days.
```

## How it works

1. **Sync.** The `hub` command finds your AI sessions for the projects you choose.
2. **Summarise.** Claude Code on your own computer writes a short summary. Secrets are stripped before anything is uploaded.
3. **Ask.** Any assistant connected to your hub reads the project's briefing: Claude Code, claude.ai, desktop or mobile.

## Quick start: self-host

You need a Linux server with Docker and a domain name pointing at it.

```bash
mkdir -p context-hub/backups/status && cd context-hub && curl -fsSLO https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/docker-compose.yml -O https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/Caddyfile
echo "HUB_DOMAIN=hub.example.com" > .env
docker compose up -d
```

Then run this on the server:

```bash
docker compose exec context-hub hub-admin setup
```

It prints a sign-in code for the dashboard and a line to paste on your
computer. That line installs `hub`, connects the computer, asks which projects
to upload, and runs the first sync. To read the hub from claude.ai, add it as a
connector: see [Using a hub](docs/using.md#1-read-from-the-hub-in-the-claude-apps).

## Hosted hub

Not open yet. [Join the waitlist](https://hub.abdulmughnialfikri.com/#waitlist).

## Docs

- [Using a hub](docs/using.md): connect computers and the Claude apps, sync, notes, the dashboard, sign-in codes.
- [Self-hosting reference](docs/self-hosting.md): settings, admin commands, backups, operating, developing.
- [Deploy guide](deploy/README.md): the single-server setup in detail.
- [Designs and plans](docs/superpowers/): how it was built.

## Status

Live at https://hub.abdulmughnialfikri.com, used by its owner. Every push to
`main` deploys.

| Built | Planned or parked |
|---|---|
| Collector for Claude Code, Codex and Antigravity; secret stripping and a personal-data filter | Importer for claude.ai export files (waits on a real export) |
| Summaries and per-project briefings written on your computer by Claude Code (the hub's key as a fallback), with a review step that drops settled items | ChatGPT and Gemini sign-in |
| MCP lookups for Claude Code and other tools | A hub for more than one person |
| Sign-in for claude.ai, desktop and mobile; `save_note` | |
| Dashboard, activity log, sync reports, off-site backups | |
| One-line install on macOS, Linux and Windows (`hub setup`) | |

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
the privacy rules every change must keep, and what a pull request needs.
Report security problems privately, as [SECURITY.md](SECURITY.md) describes.
Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
