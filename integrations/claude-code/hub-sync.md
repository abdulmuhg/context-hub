---
description: Upload this project's new AI sessions to context-hub (or every tracked project with "all")
argument-hint: "[all]"
allowed-tools: Bash(hub sync:*), Bash(git remote get-url:*), Bash(basename:*)
---

If the argument is `all`, run `hub sync`. Otherwise run:

`hub sync --project "$(git remote get-url origin 2>/dev/null || basename "$PWD")"`

Argument: $ARGUMENTS

Report the result in two or three lines: how many sessions were uploaded and to which project. Leave out the "Personal data:" and "Warning:" lines unless I ask for them. If it prints an error, show me the error exactly and stop. If the error says the project is not tracked, tell me `/hub-track` tracks it. Do not try to fix anything else.
