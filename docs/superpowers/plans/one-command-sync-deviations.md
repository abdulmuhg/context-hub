# One-command sync: notes on the plan

Checked against https://code.claude.com/docs/en/hooks (SessionEnd):

- The entry shape in the plan is valid. `matcher` is optional for SessionEnd, so it is left out and the hook fires for every end reason. `timeout` is in seconds.
- SessionEnd hooks share a 1.5 second budget by default, and a larger per-hook `timeout` raises it (up to 60 s). The plan's `timeout: 10` therefore lets Claude Code wait up to 10 s for this hook, but `hub sync --auto` only spawns a detached child and returns at once.

Choices where the plan was open:

- `hub sync --project/--session/--dry-run` print no "not uploaded" line (they never ask or offer); only plain `hub sync` does.
- The "not uploaded" line is printed before the sync, so the summary stays the last line.
- The existing `Uploaded N sessions. Unchanged: M.` line is kept above the new summary line (smaller change; existing tests rely on it).
- The real-spawn test (skipped on Windows) uses a stub script as the hub bundle that stays busy for 3 s, rather than a real hub bundle against a dead server, so it needs no build. It was run once on Windows with the skip removed and passed.
