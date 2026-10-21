# Local summaries: deviations from the plan

1. **Task 1 (the `claude -p` gate) was skipped at the owner's request.** The owner ran the command in their own terminal; it printed nothing useful (calls ended in `Execution error`, with a settings warning from `~/.claude/settings.local.json` when run from the home folder). The owner chose to skip the check and continue. Real `claude -p` behaviour is therefore unverified; everything is tested against a fake runner. The usage-limit fixture is hand-written (a guess).
2. **`FakeLlm` moved to core in Task 2, not Task 3.** The moved `transcript.test.ts` uses `FakeLlm`, `text` and `tool`, so `packages/core/test/fake-llm.ts` (with those helpers) was created in Task 2. The server's `helpers.ts` re-exports them.
3. **The merge prompt line change ("digests below") landed in Task 3**, as the plan says, so Task 2 stays a pure move.
4. **`PageInputs.onReviewSkipped` added (Task 3).** The worker's existing test expects a "review skipped" log line when the review fails; `buildStatePage` swallows the failure as specified, so an optional callback lets the worker keep logging it. Not in the plan's interface.
