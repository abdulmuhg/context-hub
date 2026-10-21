# Model spend: deviations from the plan

1. **Haiku 5.5 prices.** Checked against the Anthropic pricing page on 2026-10-21. They match the plan: $0.10 / $0.50 per million tokens up to 100,000 input tokens, $0.50 / $2.50 above. No difference.
2. **Cache tokens are not priced.** The plan's `priceMicroUsd(model, input, output)` has no cache arguments, and the hub does not use caching. `cache_read_tokens` and `cache_write_tokens` are stored but add nothing to `cost_micro_usd`, and do not count towards the 100K step.
3. **`usageReport` was written in Task 4, not Task 3.** The plan lists it under `usage.ts` in the Global Constraints, but it is only used by `hub-admin usage`, so it landed with its tests in Task 4. `formatUsd`, `utcDayStart`, `parseDailyBudgetUsd` and `budgetReached` were added to `usage.ts` as helpers.
4. **Existing migration tests changed.** Migration tests that rewind `user_version` on a fresh database (`db.test.ts` migration 7, and the upgrade test in `digest-store.test.ts`) now also drop `model_usage` first, because migration 8 would otherwise fail on the table that already exists. The migration 7 test now asserts `SCHEMA_VERSION >= 7`; a new test asserts it is 8.
5. **`WebConfig.dailyBudgetUsd` is required**, as the plan says, so every test that builds a `WebConfig` literal got `dailyBudgetUsd: null`.
6. **Startup warning uses `console.warn`.** The plan says "logs one warning"; no test covers `main.ts`.
7. **Model spend card with no recorded calls** also shows `· limit $<l>` when a limit is set (the plan gives the limit suffix only for the normal subline).
8. **Browser check of the Overview page.** Done on a local server with a throwaway database: desktop dark, phone light and phone dark all rendered correctly (six cards wrap to 5 + 1 on desktop, 2 × 3 on a phone). The desktop light screenshot came back cropped to the sidebar, so desktop light was not fully seen; the stylesheet's colours are shared tokens, not card-specific.
9. **Task 1 needed no changes to existing worker tests.** Their expectations still held with the new behaviour.
10. **Unrelated edits in the working tree.** `apps/collector` had uncommitted changes (progress reporting) that are not part of this plan. They were left alone and are not in any commit on this branch.
