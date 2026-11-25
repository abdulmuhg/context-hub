---
name: hub-sync
description: >-
  Upload your new AI sessions to context-hub. Use when the user invokes
  /hub-sync or asks to sync sessions to context-hub.
---

Run `hub sync --trigger slash`.

Report the result in two or three lines: the summary line it prints, and the "not uploaded" line if there is one (tell the user `hub sync` in a terminal lets them choose). Leave out the "Personal data:" and "Warning:" lines. If it prints an error, show the error exactly and stop. Do not try to fix anything else.
