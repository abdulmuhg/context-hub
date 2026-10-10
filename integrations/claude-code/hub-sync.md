---
description: Upload this project's new AI sessions to context-hub
---

Run this command and report its output to me in two or three lines:

`hub sync --project "$(git remote get-url origin 2>/dev/null || basename "$PWD")"`

If it prints an error, show me the error exactly and stop. Do not try to fix it.
