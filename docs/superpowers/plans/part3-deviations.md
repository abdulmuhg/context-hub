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

## Review fixes (after the build)

- `db.ts`, migration 3: a `state_retries` table, and a backfill that queues a digest
  for every main session stored before digests existed.
- `digest-store.ts`, `worker.ts`: a state page that fails to build now waits before
  the next try, on the same schedule as a failed digest (1 minute, 5 minutes,
  30 minutes, 2 hours, then daily). Before, it was retried on every pass, every
  5 seconds, without limit, and it blocked the pages of other projects. While a
  project is waiting, new digests do not trigger a page call; the page is flagged
  and rebuilt from all digests when the wait is over.
- One existing worker test expected an immediate retry of a failed page. It now
  advances the clock by one minute first, with a comment saying why.
- New tests: queued work survives closing and reopening the database file, and
  upgrading a Part 2 database queues its sessions.
