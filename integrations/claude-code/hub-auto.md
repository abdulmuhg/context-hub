---
description: Turn automatic sync on or off, or show its status (syncs tracked projects when a Claude Code session ends)
argument-hint: "on | off | status"
allowed-tools: Bash(hub auto on:*), Bash(hub auto off:*), Bash(hub auto status:*)
---

Argument: $ARGUMENTS

If the argument is `on`, `off` or `status`, run `hub auto <argument>`. If it is empty, run `hub auto status`. For anything else, say the argument must be on, off or status, and run nothing.

Report the result in one or two lines. After `on`, add that it syncs only tracked projects, in the background, when a Claude Code session ends, and that new projects still need `hub sync` in a terminal. If it prints an error, show it exactly and stop.
