# Design documents and plans

This folder is the project's design history: why context-hub works the way it
does. It was written as the project was built, mostly by its owner working
with AI coding assistants, so it reads like working notes rather than polished
documentation.

| Folder | What is in it |
|---|---|
| `specs/` | Design documents: the problem, what was decided and why, what was left out. Start with `2026-10-10-context-hub-design.md`. |
| `plans/` | Step-by-step implementation plans written from those designs, and `*-deviations.md` logs of where the build differed from the plan and why. |

A few things to know when reading them:

- They describe the project **as it was when written**. Later documents
  supersede earlier ones; the code and the main README are the current truth.
- "The owner" or "the developer" means the person running the reference hub.
  References to `vps-stack` are to their private deployment repository; the
  public equivalent is the [`deploy/`](../../deploy) folder.
- Server addresses and personal paths have been replaced with placeholders
  such as `<server-ip>` and `~/project/`.

New designs for significant changes are welcome here too: open an issue first,
then add a spec in `specs/` named `YYYY-MM-DD-<topic>-design.md`.
