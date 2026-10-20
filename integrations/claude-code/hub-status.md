---
description: Show whether this project is tracked by context-hub and when it last synced
allowed-tools: Bash(hub projects:*), Bash(hub status:*), Bash(git remote get-url:*), Bash(basename:*)
---

Run `hub projects` and find the line for this folder's project (from `git remote get-url origin`, or the folder name). Then run `hub status`.

Tell me in a few lines: whether this project is tracked (`[x]`), its session counts, when it last synced, and the server's totals (projects, sessions, digests pending or failed). If digests failed, say so plainly. If the project is not tracked, tell me `/hub-track` tracks it.
