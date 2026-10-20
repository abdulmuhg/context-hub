# context-hub

One private place that holds the AI assistant history of the projects you
choose, so any assistant on any account can pick up where the last one
stopped. Design: `docs/superpowers/specs/2026-10-10-context-hub-design.md`.

## Status

All four parts are built and deployed at https://hub.abdulmughnialfikri.com.
Every push to `main` deploys. Not built yet: browser login for chat apps
(claude.ai, ChatGPT, Gemini), a `save` tool, importers for chat-app exports,
and a dashboard.

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

To sync from inside Claude Code, copy
`integrations/claude-code/hub-sync.md` to `~/.claude/commands/`.

## Connect claude.ai

Add the custom connector in claude.ai (Customize > Connectors > Add custom connector) with URL `https://hub.abdulmughnialfikri.com/mcp`.

When claude.ai asks you to sign in, run:

    hub connect

Enter the code shown on the hub's sign-in page. Codes are valid 10 minutes, for one use. You can tick or untick "Also allow it to save notes to your projects."

To list and revoke access:

    hub-admin oauth list
    hub-admin oauth revoke <id>

Sign-in needs PUBLIC_URL set on the server (production: https://hub.abdulmughnialfikri.com); without it the sign-in routes answer 404.

## Develop

    pnpm test
    pnpm typecheck
