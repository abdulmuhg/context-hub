---
name: hub-catchup
description: >-
  Catch up on this project from context-hub, then check the live git state. Use
  when the user invokes /hub-catchup or asks where the project left off.
---

Work out this project from `git remote get-url origin` (or the folder name if there is no remote), then call context-hub's `get_project` MCP tool for it. If no single project matches, call `list_projects` and pick the one for this folder, or ask the user.

The hub's page records what past sessions said, so it can be behind. Before summarizing, check the live state with `git fetch --quiet`, `git status -sb`, `git log --oneline -5`, and `git branch -a`. Where the page and the repo disagree (a branch already merged or deleted, a PR the page calls open), trust the repo and say what changed.

Then tell the user, briefly: where the project stands, what is still open, and the next step you would suggest. Mention the date of the last recorded session.
