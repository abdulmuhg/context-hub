---
name: hub-note
description: >-
  Save a note about this project to context-hub. Use when the user invokes
  /hub-note or asks to save a decision or reminder to context-hub.
---

Save this note to context-hub with the `save_note` MCP tool.

Use this folder's project: work it out from `git remote get-url origin` (or the folder name), and pass that as `project`. Write a short title of your own, and keep the text as the user wrote it, tidied only for clarity. Never include passwords, keys, tokens, card numbers, or phone numbers.

If the user gave no note text, ask what to save. If no `save_note` tool is available, tell the user that `save_note` requires an OAuth grant with save permission (read-only MCP tokens only expose read tools), and stop. When it is saved, tell the user the project and the note's id in one line.
