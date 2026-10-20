---
description: Start tracking this project in context-hub
allowed-tools: Bash(hub track:*), Bash(hub projects:*), Bash(git remote get-url:*), Bash(basename:*)
---

Run:

`hub track "$(git remote get-url origin 2>/dev/null || basename "$PWD")"`

If it says no project or more than one project matches, run `hub projects`, show me the candidates, and ask which one I mean. Do not pick for me. When it is tracked, tell me in one line, and say `/hub-sync` uploads it.
