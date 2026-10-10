# context-hub

One private place that holds the AI assistant history of the projects you
choose, so any assistant on any account can pick up where the last one
stopped. Design: `docs/superpowers/specs/2026-10-10-context-hub-design.md`.

## Status

Part 1 of 4: the `hub` collector. The server is not built yet, so real
uploads have nowhere to go; `hub sync --dry-run` works today.

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
