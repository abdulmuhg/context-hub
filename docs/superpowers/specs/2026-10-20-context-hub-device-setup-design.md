# context-hub — new-computer setup design

Date: 2026-10-20. Builds on the dashboard (`2026-10-20-context-hub-dashboard-design.md`)
and Part 5 sign-in. Agreed with the owner in conversation.

## Purpose

Connecting a new computer (first: the owner's Mac) today takes a clone, a
pnpm build, a hand-made launcher, SSH to the server for an upload token, and
copying slash commands. Make it:

```bash
curl -fsSL https://hub.abdulmughnialfikri.com/install | sh
hub login
```

plus one code from the dashboard. Reading from the hub already needs nothing
on a new computer: Claude Code picks up the claude.ai connector from the
owner's account.

## Decided

1. **Two kinds of one-time code.** The existing connect codes gain a
   `purpose`: `signin` (Claude apps and browsers, as today) or `device`
   (exchange for an upload token). A code works only for its own purpose.
   Both stay 10 minutes, one use, hashed, limited by the failed-login
   limiter.
2. **The dashboard's Sign-ins page gets two buttons:** "Add a computer"
   (device code) and "New sign-in code" (sign-in code, for claude.ai or
   another browser). Each shows the code once, with its expiry and what to do
   with it. For "Add a computer" that is the install line and `hub login`.
   `hub connect` and `hub-admin connect-code` keep working.
3. **`POST /api/devices`**, unauthenticated: a device code and a computer
   name in, a new upload (`ingest`) token labelled with that name out, shown
   once. Wrong codes count toward the limiter. The new token appears under
   Sign-ins > Tokens with its own Disconnect, so a lost laptop can be cut off.
4. **The hub serves its own client.** `GET /hub.mjs` returns the `hub`
   command as one file (the collector's existing self-contained bundle,
   copied into the server image). `GET /install` returns a POSIX shell
   script, with the hub's `PUBLIC_URL` filled in, that checks for Node 22 or
   newer, puts the bundle in `~/.local/share/context-hub/`, adds a `hub`
   launcher in `~/.local/bin`, installs the Claude Code slash commands, and
   prints the next step. Running it again updates in place and keeps
   `~/.context-hub` untouched. Both routes are public: the client holds no
   secret. Both answer 404 when `PUBLIC_URL` is unset.
5. **`hub login`** asks for the hub address (default: the saved one, or the
   one the installer prints), a name for this computer (default: the host
   name), and the device code; then saves the address and token exactly as
   `hub init` does. Logging in to a different hub than the saved one asks
   first.
6. **`hub install-commands`** writes the five slash commands to
   `~/.claude/commands/`. The command texts live in the collector's source
   so the bundle carries them; `integrations/claude-code/*.md` stays in the
   repo and a test keeps the two identical.

## Not in this change

- A Windows installer. Windows keeps the manual setup (README) for now.
- Automatic updates of `hub`; rerunning the install line updates it.
- Any change to how reading works.

## Security notes

- The device-code exchange is the only unauthenticated route that creates a
  credential. It is gated by a 10-minute single-use code that only a
  signed-in dashboard can create, and by the limiter.
- The computer name is user input: cut to 40 characters of letters, digits,
  space, `.`, `_` and `-`, defaulting to `computer`. Pages already escape
  token labels.
- The install script embeds only `PUBLIC_URL`, which startup already
  validates (https, no path).
