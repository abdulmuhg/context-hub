---
name: hub-auto
description: >-
  Turn automatic sync on or off, or show its status (syncs tracked projects when
  a Claude Code or Antigravity session stops). Use when the user invokes
  /hub-auto.
---

If the user asked for `on`, `off`, or `status`, run `hub auto <argument>`. If no argument was given, run `hub auto status`. For anything else, say the argument must be `on`, `off`, or `status`, and run nothing.

Report the result in one or two lines. After `on`, add that it syncs only tracked projects, in the background, when a Claude Code or Antigravity session stops, and that new projects still need `hub sync` in a terminal. If it prints an error, show it exactly and stop.
