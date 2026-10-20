# context-hub

One private place that holds the AI assistant history of the projects you
choose, so any assistant on any account can pick up where the last one
stopped. Design: `docs/superpowers/specs/2026-10-10-context-hub-design.md`.

## Status

All four parts are built and deployed at https://hub.abdulmughnialfikri.com.
Every push to `main` deploys. Sign-in for the Claude apps is built on the
`part5-oauth` branch and switches on when `PUBLIC_URL` is set on the server.
Not built yet: ChatGPT and Gemini sign-in, a `save` tool, importers for
chat-app exports, and a dashboard.

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
