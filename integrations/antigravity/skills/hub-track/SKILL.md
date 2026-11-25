---
name: hub-track
description: >-
  Start tracking this project in context-hub. Use when the user invokes
  /hub-track.
---

Work out the project name from `git remote get-url origin` (or the current folder name if there is no remote), then run `hub track "<project>"`.

If it says no project or more than one project matches, run `hub projects`, show the candidates, and ask which one the user means. Do not pick for them. When it is tracked, tell the user in one line, and say `/hub-sync` uploads it.
