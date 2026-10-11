# context-hub

One private place that holds the AI assistant history of the projects you
choose, so any assistant on any account can pick up where the last one
stopped. Design: `docs/superpowers/specs/2026-10-10-context-hub-design.md`.

## Status

Parts 1 and 2 of 4: the `hub` collector and the server. Digests and project
state pages (part 3) and deployment (part 4) are not built yet, so the lookup
tools return `digest: null` and `state: null`.

## Run the server locally

    pnpm --filter @context-hub/server build
    DATABASE_PATH=./data/hub.sqlite node apps/server/dist/main.js

    # in another terminal, same DATABASE_PATH
    node apps/server/dist/admin-bin.js token create --label collector --scope ingest
    node apps/server/dist/admin-bin.js token create --label my-assistant --scope read

Give the ingest token to `hub init`. Give the read token to an assistant as a
bearer token for `http://localhost:3000/mcp`.

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

## Develop

    pnpm test
    pnpm typecheck
