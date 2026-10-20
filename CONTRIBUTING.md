# Contributing to context-hub

Thanks for helping. This guide covers setting up, making a change, and what a
pull request needs.

## Before you start

- **Bugs and small fixes:** open a pull request directly, or an issue first if
  you are not sure it is a bug.
- **New features or bigger changes:** open an issue first and describe the
  problem you want to solve. context-hub stores people's private AI history,
  so changes to what is collected, uploaded or shown get discussed before code.
- **Security problems:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node 22 or newer and pnpm (the version is pinned in `package.json`;
`corepack enable` picks it up).

```bash
git clone https://github.com/abdulmuhg/context-hub.git
cd context-hub
pnpm install
pnpm typecheck
pnpm test
```

The repository is a pnpm workspace:

| Folder | What it is |
|---|---|
| `packages/core` | Shared code: the session format, secret stripping, the personal-data filter |
| `apps/collector` | The `hub` command: reads local AI sessions and uploads them |
| `apps/server` | The hub: storage, search, summaries, MCP tools, sign-in, dashboard |
| `integrations/claude-code` | The Claude Code slash commands |
| `docs/superpowers` | Design documents and plans, the history of why things are the way they are |

Run the server locally:

```bash
pnpm --filter @context-hub/server build
DATABASE_PATH=./data/hub.sqlite node apps/server/dist/main.js
```

## Making a change

- **Write a test first** for a bug or a new behaviour, see it fail, then make
  it pass. Every change ships with tests; `pnpm test` and `pnpm typecheck`
  must pass.
- **Match the code around you:** naming, comment style, and how errors are
  worded. Comments explain *why*, not *what*.
- **Database changes go in a new migration** in `apps/server/src/db.ts`.
  Never edit an existing one; hubs that already ran it would not run it again.
- **No new dependencies** without discussing it in an issue first. The
  collector in particular is shipped as one self-contained file.
- **Keep the user-visible wording plain:** short sentences, no jargon, sentence
  case, and say what happened and what to do next.

### Privacy rules

These protect the people who run context-hub. A pull request that breaks one
will not be merged.

- **Never commit real session data,** real tokens, keys or personal details,
  even in tests. Build test secrets by joining strings
  (`'gh' + 'p_' + 'a'.repeat(36)`) so they are clearly fake and do not trip
  secret scanners.
- **Nothing leaves the computer unless its project is tracked.** Changes to the
  collector must keep that true.
- **Secrets are stripped before upload and again on the server.** New ways of
  reading sessions must go through the same stripping.
- **Nothing about a hub's contents is visible without signing in.**

## Commits and pull requests

- One logical change per commit, with a message whose first line says what it
  does in the imperative ("Add …", "Fix …") and whose body says why.
- Keep pull requests focused. Fill in the template: what changed, why, and how
  you tested it.
- CI runs the typecheck and the whole test suite on every pull request.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
