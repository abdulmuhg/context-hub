# Part 6 deviations

| # | Task | Deviation | Reason |
|---|---|---|---|
| 1 | 3 | An empty hub renders as `Projects in the hub: The hub has no projects yet..` — the `<names>` replacement text ends in a period and the template adds its own. | The plan gives both texts character-for-character; substituting literally is the smaller change, and a second template just for punctuation would drift from the exact wording. |
| 2 | 3 | `save_note` timestamps a note with `new Date().toISOString()` rather than the handler's injected `now`. | `buildMcpServer` has no clock seam and the plan adds none; threading `deps.now` through `AppDeps.mcp` would be a wider change than the spec asks for. Tests do not depend on the note's timestamp. |
