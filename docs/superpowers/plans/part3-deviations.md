# Part 3 deviations

Fixes found in the final review. They are not plan code.

## Subagent filter in the queue (digest-store.ts)

`nextDueDigest` and the EXISTS subquery in `nextProjectNeedingState` now also require
`s.parent IS NULL`, matching `okDigestsForProject`. Before, a subagent row with an ok
digest and no page made `runOnce` return `'state'` without ever producing a page, so the
worker looped without progress. Test: `a subagent row is neither due nor a reason to
build a project page` in `digest-store.test.ts`.

## Lost dirty flag during a page update (worker.ts)

`saveProjectState` sets `dirty = 0`, so a `markStateDirty` raised by a delete or move
while the model call was running was silently cleared and the page reported fresh while
describing removed work. The worker now records the list of ok-digest session ids of the
project before the model call (`pageSources`) and, after saving, marks the page dirty
again when the list changed (`savePage`). The `saveProjectState` signature is unchanged.
Test: `keeps the page stale when a session is deleted while the page is being rebuilt`
in `worker.test.ts`.
