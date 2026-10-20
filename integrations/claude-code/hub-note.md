---
description: Save a note about this project to context-hub
argument-hint: "<what to remember>"
---

Save this note to context-hub with the `save_note` tool:

$ARGUMENTS

Use this folder's project: work it out from `git remote get-url origin` (or the folder name), and pass that as `project`. Write a short title of your own, and keep the text as I wrote it, tidied only for clarity. Never include passwords, keys, tokens, card numbers or phone numbers.

If the argument is empty, ask me what to save. If no `save_note` tool is available, tell me it comes with the claude.ai context-hub connector (signed in with "save notes" allowed), and stop. When it is saved, tell me the project and the note's id in one line.
