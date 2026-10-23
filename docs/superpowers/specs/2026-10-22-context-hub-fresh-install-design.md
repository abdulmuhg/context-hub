# Fresh install journey: design

Date: 2026-10-22
Status: draft for the owner's review

## Intent

A new computer should go from nothing to connected and syncing with one copied
line. The owner's words: **quick, each step clear, minimum user input, clear
error messages.**

This is the first of the "seamless setup" journeys. It covers one computer,
from first paste to its first sync. Connecting claude.ai, which happens once
per account rather than once per computer, is the next journey and is not
designed here.

## Where things stand today

- `GET /install` (`apps/server/src/client-dist.ts`) is a POSIX sh script. It
  checks Node 22+, downloads the one-file bundle from `/hub.mjs` to
  `${XDG_DATA_HOME:-~/.local/share}/context-hub/hub.mjs`, writes a `hub`
  launcher in `~/.local/bin` and runs `hub install-commands`. When
  `~/.local/bin` is not on PATH it prints the profile line to add, and it ends
  with `Next: hub login --url …`.
- **Sign-ins → Add a computer** (`codePage` in `apps/server/src/web/pages.ts`)
  shows the code on its own, then `curl … | sh` and `hub login` as two lines.
- `hub login` (`apps/collector/src/cli.ts`) asks for the hub address (unless
  saved or given with `--url`), a name for the computer (the host name by
  default) and the code. It asks y/N before replacing a different saved hub.
  The server returns the token's label, but the collector does not store it,
  so the Git section of a project page names the host name instead.
- **Windows has no installer.** The README tells you to clone, build and write
  `hub.cmd` by hand.
- Auto sync is off until `hub auto on`.
- New projects are decided one at a time by a `[y/N]` question inside
  `hub sync`, and only when stdin and stdout are a terminal.
- `hub doctor` already prints a ✓ / ! / ✗ checklist (hub address, connection,
  tracked projects, Claude Code and so on).

That makes seven steps today: get a code, install, log in, sync, `hub auto on`,
check Claude Code, and (on Windows) build by hand.

## Goals

1. **One line to paste, per OS, with the code already in it.** The Add a
   computer page shows a macOS/Linux line and a Windows (PowerShell) line,
   each carrying the fresh one-time code. You never type a code.
2. **Windows works the same as macOS and Linux.** The hub serves
   `/install.ps1`, which runs in Windows PowerShell 5.1 (the version every
   Windows 11 machine has) and does what the sh installer does.
3. **No questions until the very end.** The installer asks nothing until it
   has finished setting up. The only question is which projects to upload.
4. **It finishes with a checklist** that says what is now true and what, if
   anything, still needs you, with the command to run.
5. **Auto sync is on after a first install.**
6. **Every failure along the way says what happened and the one thing to do
   next.** No stack traces and no raw HTTP codes on screen.
7. **Pasting the line again is safe.** It updates `hub` and repairs anything
   missing, but keeps the login and leaves settings you changed alone.

## Non-goals

- Connecting claude.ai, Claude desktop or mobile (the next journey).
- Hooks for Codex or Antigravity.
- Shipping `hub` as a self-contained binary without Node. It stays a Node 22
  bundle.
- Accounts for more than one person.
- Changes to what a sync uploads, secret stripping, or summaries.

## Anti-goals (this fails even if it works)

- **A project is uploaded that you didn't choose.** Track-before-upload stays:
  nothing goes up without an explicit pick.
- **The code shows up in a URL or a server log.** It travels only as an
  argument or an environment variable on your own computer. It may land in
  shell history. That is acceptable because it is single-use, expires in 10
  minutes and is used within seconds.
- **The installer changes your system without saying so.** Every change it
  makes (PATH, a profile file, the Claude Code hook) appears in the final
  checklist.
- **Existing computers break.** `curl … | sh` followed by `hub login` (the
  two-step form) must keep working, and so must `hub login` with prompts.

## The journey

### Step 1: Add a computer (dashboard)

The page made by **Add a computer** shows:

- The code, as it does today, for anyone running `hub login` by hand.
- **macOS / Linux** (`--code` is passed to the script):
  `curl -fsSL https://HUB/install | sh -s -- --code K7P4QX`
- **Windows (PowerShell)**, one line that can be pasted into a PowerShell
  window. The exact form is the builder's call (see below).
- Copy buttons. The OS the browser reports is shown first; the other OS
  stays visible.
- "Valid for 10 minutes, for one use", as today.

### Step 2: The installer runs without questions

The sh and PowerShell installers stay thin. They do only what has to happen
before `hub` exists, then hand over to one new command, `hub setup`, which
holds all the logic in TypeScript, where it can be tested once for both OSes.

**Installer (sh or ps1):**

1. **Check Node 22 or newer.** If it is missing or too old, stop before
   changing anything, with one message that gives the install command for this
   machine:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS with Homebrew: `brew install node`; otherwise the nodejs.org link
   - Linux: the nodejs.org link

   The message adds: "then open a new terminal and paste the same line again.
   If more than 10 minutes have passed, get a new line from Sign-ins → Add a
   computer." *(The designer's call: never install Node ourselves.)*
2. **Install `hub`.** Download `/hub.mjs` to a temporary file first and move it
   into place only when the download is complete, so a failed download leaves
   the old version working (the sh installer already does this). Write the
   launcher: `hub` on macOS/Linux, `hub.cmd` on Windows, in a per-user folder
   (Windows: under `%LOCALAPPDATA%\context-hub`).
3. **Put `hub` on PATH.**
   - Windows: add the folder to the user's PATH (not the machine's), and to
     the current session so `hub` works at once.
   - macOS/Linux: if `~/.local/bin` is not on PATH, append one marked line to
     the profile of the user's login shell (`~/.zshrc` for zsh, `~/.bashrc`
     for bash, otherwise `~/.profile`). Never add it twice.
   - Report the change in the checklist. *(The designer's call: today the sh
     installer only prints the line for you to add; minimum input means doing
     it.)*
4. **Run `hub setup --url https://HUB [--code K7P4QX]`**, giving it the
   terminal for input. Under `curl | sh` the script's own stdin is the pipe, so
   the sh installer reads from `/dev/tty` when one exists.

**`hub setup` (new command):**

1. **Connect.**
   - With `--code`: exchange it without asking. The computer is named with
     the label stored in its config if it has one, otherwise its host name, so
     a repair paste never renames a computer (the name appears next to
     summaries and in the Git section). If the computer is already connected,
     replace the token (the paste is a clear signal you want this hub) and say
     which hub it was connected to before when that changes.
   - **Retire the old token on replace.** *(Designer's call.)* When the
     computer already holds a token for the same hub, the code exchange sends
     it along, and the server revokes it once the new one is issued, so
     repeated pastes don't pile up live tokens on Sign-ins. This is a small
     server change: the device-code exchange (`apps/server/src/devices.ts`)
     accepts the current token and revokes it with the existing
     `revokeToken`. An old token the server doesn't recognise is ignored.
   - Without `--code` and already connected to this hub: check the token
     still works and keep it ("Already connected as MRC").
     `/api/status` returns the token's label so computers that never stored
     one can show it, and the collector stores it then. *(Designer's call.)*
   - Without `--code` and not connected: stop with "Get a line with a code from
     Sign-ins → Add a computer."
   - Store the label the hub returns in the config. This also fixes the Git
     section naming the host name.
2. **Install the slash commands** (as `hub install-commands`).
3. **Turn on auto sync, on a first install only.** "First install" means no
   config existed before this run. On a re-run, leave auto sync on or off as
   you set it. If Claude Code is not installed, skip this and say why in the
   checklist.
   **On every run, repoint our hook.** *(Designer's call.)* If a context-hub
   SessionEnd hook already exists, it is rewritten to run the bundle just
   installed, so a hook written by an older install (for example one pointing
   at a clone's `apps/collector/dist/bin.js`) never keeps running an old
   build, and there are never two hooks. `autoOn`/`autoOff`
   (`apps/collector/src/auto.ts`) therefore recognise our hook by its
   `sync --auto` command shape, not by its exact path.
4. **Check Claude Code.** Is it installed and signed in, so summaries can be
   written here? This is a warning, not a failure: the computer is still
   connected.
5. **Print the checklist** in the same ✓ / ! / ✗ style as `hub doctor`, for
   example:

   ```
   ✓ hub 2026.10.22 installed in C:\Users\you\AppData\Local\context-hub
   ✓ Added hub to your PATH (user)
   ✓ Connected to https://HUB as "MRC"
   ✓ Slash commands installed (6)
   ✓ Auto sync on (runs when a Claude Code session ends)
   ! Claude Code isn't signed in, so summaries can't be written here.
     Run: claude auth login
   ```
6. **Pick projects** (only when there is a terminal to ask in). List the
   projects found on this computer that are not decided yet, numbered, with
   session count and last activity:

   ```
   Found 6 projects on this computer:
     1  github.com/you/context-hub     42 sessions   today
     2  github.com/you/jsonroom        12 sessions   3 days ago
     …
   Which should go to the hub? Numbers (e.g. 1 3), "all", or Enter for none:
   ```

   The picks are tracked; the rest are recorded as "no", exactly as answering
   `n` in `hub sync` does today. Enter or no terminal: nothing is decided, and
   the next `hub sync` asks as it does now.
7. **Start the first sync** of the picked projects (see the open question
   below about foreground or background), then print the last line:
   "Done. This computer syncs when a Claude Code session ends; run hub sync
   any time."

### Step 3: Errors

Every failure in the installers and in `hub setup`, `hub login`, `hub doctor`
and `hub sync` reads as **what happened + the one thing to do**. The ones the
journey must cover:

| What went wrong | What you see |
|---|---|
| Code expired, used or mistyped | "That code didn't work: it has expired, was already used, or was mistyped. Get a new line from Sign-ins → Add a computer and paste it." (The server keeps not saying which, as today.) |
| Hub unreachable (DNS, TLS, timeout, refused) | "Can't reach https://HUB (*reason in plain words*). Check your internet connection and the address, then paste the line again." |
| Node missing or too old | As in installer step 1. |
| Download of the bundle failed | "Couldn't download hub from https://HUB/hub.mjs (*reason*). Nothing was changed. Paste the line again." |
| A folder or PATH can't be written | Names the path, and gives the full path to `hub` so it still works today. |
| Token refused later (disconnected on the dashboard) | "This computer was disconnected from the hub. Get a new line from Sign-ins → Add a computer and paste it." |
| Claude Code missing or signed out | A warning in the checklist with the command, never a failure. |
| Anything unexpected | "Something went wrong: *one-line message*. Details are in *log path*." The stack trace goes to the log, not the screen. |

The collector gets one top-level handler that turns any unexpected error into
the last row, so a new bug can never show a raw trace.

### Re-running the line

The same line, pasted again with a fresh code, is the repair and update path.
The installer replaces the bundle; `hub setup` keeps the existing config,
re-checks everything, fixes what is missing (commands, PATH) and prints the
checklist. A line without a code (`curl … | sh`) on an already connected
computer updates and checks without logging in again.

## Constraints

- Windows PowerShell 5.1 must be enough; PowerShell 7 must not be required.
  Note that `&&` and the `??` operator don't exist in 5.1.
- The PowerShell installer must not need the execution policy changed.
- The server never logs the code. Neither `/install` nor `/install.ps1` takes
  the code in the URL.
- No new runtime dependencies in the collector bundle.
- Existing commands (`hub login` with prompts, `hub install-commands`,
  `hub auto on`) keep working and keep their meaning.
- Update the README's "Install and log in" section so there is one path per
  OS, and close issue #6 (Windows installer).

### Version

*(Designer's call.)* The bundle build stamps a version made of the build date
and the short git commit (for example `2026.10.22-13aa17c`). `hub --version`
prints it, and the checklist's first line says "installed", "updated from X
to Y" or "already current". `apps/collector/package.json` stays as it is.

## Left to the builder

- The exact Windows one-liner (for example a `$env:` variable set before
  `irm … | iex`, or a script block taking `-Code`), as long as it is one
  pasteable line in PowerShell 5.1 and keeps the code out of the URL.
- How the page detects the OS, and how it lays the two lines out.
- Exact wording of messages, within the "what happened + what to do" rule.
- Where the log for unexpected errors lives, as long as it is under the
  existing `~/.context-hub` folder.
- How the installers are tested. The minimum: unit tests on the generated
  script text, and `hub setup` tested through the existing `Io` fakes. Before
  this is called done, both installers must have run for real once, on this
  Windows PC and on the Mac.

### First sync runs in the foreground (owner's decision)

`hub setup` runs the first sync of the picked projects in the foreground with
the same progress line `hub sync` shows, and prints its last line only when
the sync is done. Ctrl+C stops it safely: whatever is already uploaded stays
uploaded, the rest waits for the next sync, and the message says so ("Stopped.
The rest uploads on the next sync, or run hub sync."). With no projects picked,
there is no sync.

### The installed `hub` wins on PATH (owner's decision)

On the owner's PC, `%APPDATA%\npm\hub.cmd` runs the clone's build and would
win over anything appended to PATH. The installed `hub` must be the one that
runs; dev builds are run as `node apps/collector/dist/bin.js`.

- The installer puts its folder **first** on the user PATH (Windows) and
  prepends it in the profile line (macOS/Linux), rather than appending.
- Then it checks which `hub` the shell would actually run. If that is still
  another file, and the file is a context-hub launcher (its text runs
  context-hub's `bin.js` or `hub.mjs`), the installer renames it to
  `<name>.old` and says so in the checklist. *(Designer's call: renaming
  rather than deleting, so it can be put back.)*
- If the other `hub` is not ours (it doesn't mention context-hub), it is left
  alone, and the checklist warns with its path and the full path of the
  installed one.
