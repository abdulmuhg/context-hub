# context-hub

One private place that holds the AI assistant history of the projects you
choose, so any assistant on any account can pick up where the last one
stopped. Design: `docs/superpowers/specs/2026-10-10-context-hub-design.md`.

## Status

All four parts are built and deployed at https://hub.abdulmughnialfikri.com.
Every push to `main` deploys. Sign-in for the Claude apps is built on the
`part5-oauth` branch and switches on when `PUBLIC_URL` is set on the server.
The dashboard is built on the `dashboard` branch. Not built yet: ChatGPT and
Gemini sign-in, a `save` tool, and importers for chat-app exports.

## Run the server locally

    pnpm --filter @context-hub/server build
    DATABASE_PATH=./data/hub.sqlite node apps/server/dist/main.js

    # in another terminal, same DATABASE_PATH
    node apps/server/dist/admin-bin.js token create --label collector --scope ingest
    node apps/server/dist/admin-bin.js token create --label my-assistant --scope read

Give the ingest token to `hub init`. Give the read token to an assistant as a
bearer token for `http://localhost:3000/mcp`.

## Digests

Set `ANTHROPIC_API_KEY` before starting the server and it writes a digest of
each uploaded session and keeps a state page per project. Without the key the
server still works; digests wait in a queue.

    DIGEST_MODEL              default claude-haiku-5-5
    DIGEST_EFFORT             default low
    DIGEST_MAX_INPUT_TOKENS   default 80000

    node apps/server/dist/admin-bin.js digests
    node apps/server/dist/admin-bin.js redigest <project>
    node apps/server/dist/admin-bin.js rebuild-state <project>

A digest is a summary and can be wrong. The stored conversation is the
authority, and every digest item points at the message it came from.

## Install the collector

    pnpm install
    pnpm --filter @context-hub/collector build
    cd apps/collector && pnpm link --global

## Use

    hub projects                 # what is on this PC
    hub track <project>          # nothing is uploaded until you track it
    hub sync --dry-run           # see what would be sent
    hub sync                     # send it

`hub personal add phone` adds one of your own values to the personal data
list. The default level is `warn`: the value is reported but still uploaded.
Raise it with `hub personal level list partial` or `full`.

### Slash commands for Claude Code

`integrations/claude-code/` holds five commands. Copy them to
`~/.claude/commands/` to use them in every repo:

```
cp integrations/claude-code/hub-*.md ~/.claude/commands/
```

| Command | What it does |
|---|---|
| `/hub-sync` | Upload this project's new sessions. `/hub-sync all` uploads every tracked project. |
| `/hub-catchup` | Read this project's hub page, check the live git state, and say where things stand. |
| `/hub-note <text>` | Save a note to this project. Needs the claude.ai connector with "save notes" allowed. |
| `/hub-status` | Whether this project is tracked, when it last synced, and the server's totals. |
| `/hub-track` | Start tracking this project. |

Each works out the project from the folder's `origin` remote, or the folder
name when there is none. Copy the files again after changing them.

## The dashboard

The hub's own web pages are at the hub's URL —
https://hub.abdulmughnialfikri.com — and show what it holds and how it is
doing. Nothing on them is public: signed out, every page is the sign-in
screen.

**Signing in.** Run `hub connect` on the PC and enter the code it prints on
the sign-in page. It is the same one-time code the Claude apps use: valid 10
minutes, for one use. Ten wrong codes in 5 minutes blocks that address for 15
minutes. A sign-in lasts **30 days**, in one `HttpOnly` cookie per browser, so
phone and desktop are separate sign-ins. **Sign out** is at the bottom of the
sidebar, and the light/dark switch is in the header.

| Page | What it shows |
|---|---|
| **Overview** | Healthy or Needs attention, the project and session counts, the last sync the PC reported, the last backup (with whether it reached off-site storage), anything wrong right now (failed or stuck summaries, sync quiet for more than 3 days, a backup older than 26 hours), the last 10 things that happened, and the running version. |
| **Activity** | Everything saved in or read out over the last 30 days, newest first, 50 to a page, filterable by direction. Each row says who did it: the PC's collector, claude.ai, or a named read token. |
| **Projects** | Every project with its session count, last activity and one-line summary. Opening one shows its full briefing — the state page, then recent sessions and notes with their digest status. |
| **Sign-ins** | Every way into the hub: the Claude apps' sign-ins, the upload and read tokens, and the signed-in browsers (this one marked). Each has a **Disconnect** that asks once more and names what breaks — disconnecting the upload token stops `hub sync` until a new one is made on the server, and disconnecting this browser signs it out. |

**Rebuild the `hub` command once** on the PC after pulling this branch —
`pnpm --filter @context-hub/collector build` (see "Install the collector") —
or Overview keeps saying sync has gone quiet: reporting a sync run is new in
the collector, and the server only knows what it is told.

**Monitoring probes go to `/healthz`**, which still answers plain JSON without
a sign-in. `/` is the dashboard now, not the old JSON landing page, and
answers `302` to `/login` when signed out.

## Connect claude.ai

Add the custom connector in claude.ai (Customize > Connectors > Add custom connector) with URL `https://hub.abdulmughnialfikri.com/mcp`. Use the URL exactly as written, with no trailing slash.

When claude.ai asks you to sign in, run:

    hub connect

Enter the code shown on the hub's sign-in page. Codes are valid 10 minutes, for one use. You can tick or untick "Also allow it to save notes to your projects."

**Saving notes from a chat**

Ask the chat to save something to a named project. The project must already exist; a note never creates one. Notes appear with source `note` in get_project and search. This requires the connector's sign-in grant: when signing in, tick "Also allow it to save notes to your projects." Remove a note with `hub forget --session note:<id>`.

claude.ai keeps the tool list it fetched when the connector was connected. After a deploy that adds or changes tools, open Customize > Connectors > context-hub, click Disconnect, then Connect, and sign in with a new `hub connect` code.

To list and revoke access:

    hub-admin oauth list
    hub-admin oauth revoke <id>

Sign-in needs PUBLIC_URL set on the server (production: https://hub.abdulmughnialfikri.com); without it the sign-in routes answer 404.

## Develop

    pnpm test
    pnpm typecheck
