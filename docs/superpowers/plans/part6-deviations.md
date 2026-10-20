# Part 6 deviations

| # | Task | Deviation | Reason |
|---|---|---|---|
| 1 | 3 | Fixed, not a deviation: `projectNames` returns `The hub has no projects yet` without a trailing period, so each description template supplies the one period the plan writes. An empty hub reads `... Projects in the hub: The hub has no projects yet.` | The plan's `<names>` replacement text was written with a period while every template already ends in one, which first produced `yet..`. Dropping it from the replacement renders all four descriptions character-for-character as the plan writes them. Pinned by whole-string equality tests in `test/mcp.test.ts`. |
| 2 | 3 | `save_note` timestamps a note with `new Date().toISOString()` rather than the handler's injected `now`. | `buildMcpServer` has no clock seam and the plan adds none; threading `deps.now` through `AppDeps.mcp` would be a wider change than the spec asks for. Tests do not depend on the note's timestamp. |
| 3 | 4 | Task 4 Step 1 / final review: `forget` accepts `note:<id>`; spec says it already works but the client regex rejected it. `skip`, `unskip` and `assign` still reject `note:`. | Smaller than dropping the README sentence, which would remove the spec's removal path for a note. Pinned by a `forget --session note:n_abc` test and a `skip note:x` rejection test in `test/cli.test.ts`. |
| 4 | 3 | `account_id` is null for notes per the plan's Global Constraint, although spec 4.1 says "taken from the grant if known". | The plan binds. A follow-up could take it from the grant. |

## Out of scope, noted

- `search`'s `source` parameter is described as "Limit to one tool", which now also covers `note` (a note comes from a chat, not a coding tool). Left as written; the plan does not change that parameter's text.
- A project whose short name is shared by two keys (for example `local:dup` and `github.com/me/dup`) appears twice in a description, and the model has no way to tell them apart. `save_note` still answers with the candidate keys and saves nothing.

## Manual test results (Task 4, 2026-10-20)

Deployed as `f80c6ce`; healthy, no restarts; Claude Code still connected with its read token.

- **A plain question picks the hub: pass.** In a new claude.ai chat after reconnecting, "Where did we leave off on jsonroom?" answered from the hub's jsonroom page with no mention of the hub in the prompt.
- **New tools need a reconnect.** The first chat after the deploy did not see `save_note`: claude.ai kept the tool list from the 06:52 connection. Disconnect and Connect in claude.ai fetched the new list. Worth a line in the README.
- **Token refresh: pass.** claude.ai rotated grant 1's refresh token at 08:56:33 after the first access token expired.
- **Fresh sign-in on a second connection: pass.** Reconnecting used a second connect code and created grant 2 (`hub.read hub.save offline_access`). This closes Part 5's open item.
- **`save_note`: pass.** The note `note:n_MDtPpdm8YjVL8nloF2JfDA` was stored, digested with `model = 'note'` and no model call, and found by `search` from Claude Code with `source: note`.
- **Wrong project.** Asked to save "to context-hub", Claude filed the note under jsonroom "because that's what we were just talking about". "context-hub" names both the hub and a project, so the request read as "save to the hub". Fix: the `save_note` description should say to use the project the user names and to ask when they name none.
- Grant 1 is still active but unused since the reconnect; revoke it.
