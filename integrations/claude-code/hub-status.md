---
description: Show whether this project is tracked by context-hub, when it last synced, and whether automatic sync is on
allowed-tools: Bash(hub projects:*), Bash(hub status:*), Bash(hub auto status:*), Bash(git remote get-url:*), Bash(basename:*)
---

Run `hub projects` and find the line for this folder's project (from `git remote get-url origin`, or the folder name). Then run `hub status` and `hub auto status`.

Tell me in a few lines: whether this project is tracked (`[x]`), its session counts, when it last synced, the server's totals (projects, sessions, digests pending or failed), and whether automatic sync is on with its last run. If digests failed or the last automatic run was an error, say so plainly. If the project is not tracked, tell me `/hub-track` tracks it. If automatic sync is off, mention `/hub-auto on` once.
