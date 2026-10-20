---
description: Catch up on this project from context-hub, then check the live git state
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git branch:*), Bash(git remote get-url:*), Bash(git fetch:*), Bash(basename:*)
---

Work out this project from `git remote get-url origin` (or the folder name if there is no remote), then call context-hub's `get_project` for it. If no single project matches, call `list_projects` and pick the one for this folder, or ask me.

The hub's page records what past sessions said, so it can be behind. Before you summarise, check the live state with `git fetch --quiet`, `git status -sb`, `git log --oneline -5` and `git branch -a`. Where the page and the repo disagree (a branch already merged or deleted, a PR the page calls open), trust the repo and say what changed.

Then tell me, briefly: where the project stands, what is still open, and the next step you would suggest. Mention the date of the last recorded session.
