# Part 6 deviations

| # | Task | Deviation | Reason |
|---|---|---|---|
| 1 | 3 | Fixed, not a deviation: `projectNames` returns `The hub has no projects yet` without a trailing period, so each description template supplies the one period the plan writes. An empty hub reads `... Projects in the hub: The hub has no projects yet.` | The plan's `<names>` replacement text was written with a period while every template already ends in one, which first produced `yet..`. Dropping it from the replacement renders all four descriptions character-for-character as the plan writes them. Pinned by whole-string equality tests in `test/mcp.test.ts`. |
| 2 | 3 | `save_note` timestamps a note with `new Date().toISOString()` rather than the handler's injected `now`. | `buildMcpServer` has no clock seam and the plan adds none; threading `deps.now` through `AppDeps.mcp` would be a wider change than the spec asks for. Tests do not depend on the note's timestamp. |

## Out of scope, noted

- `search`'s `source` parameter is described as "Limit to one tool", which now also covers `note` (a note comes from a chat, not a coding tool). Left as written; the plan does not change that parameter's text.
- A project whose short name is shared by two keys (for example `local:dup` and `github.com/me/dup`) appears twice in a description, and the model has no way to tell them apart. `save_note` still answers with the candidate keys and saves nothing.
