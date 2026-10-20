# Dashboard deviations

- Task 1 — the "migration 4" test in db.test.ts now asserts `SCHEMA_VERSION >= 4` instead of `=== 4`, and the upgrade test in digest-store.test.ts also drops the three new tables when rewinding to version 1 — both replay or pin older schema versions, so migration 5 broke them (same fix Part 5 used).
- Task 2 — `findToken` in oauth/store.ts now also selects `g.client_name` and returns it as `grant.clientName`, so `checkCredential` can put `clientName` on OAuth credentials — the existing join already reached the grant row, so one extra column was the smallest change.
- Task 2 — added `logActivitySafe` (try/catch around `logActivity`, errors go to the server log) in activity.ts; the brief asked each call to be wrapped, one shared helper does it.
- Task 2 — existing tests that pinned `checkCredential`'s exact result (tokens.test.ts) and the MCP caller (http.test.ts, mcp.test.ts `canSave: true`) were updated for the new `id`/`label`/`clientName`/`actor` fields.
- Task 3 — the existing "uploads and prints a summary" cli test now expects the extra `POST /api/sync-runs` request, and the sync.test.ts fake server records reports in a separate `reports` list so existing `sent` assertions are unchanged — every real sync now sends a report.
- Task 3 — a failed report is returned as an optional `reportError` on `SyncReport` and printed by `printReport` (one stderr line starting "Note: could not report this run"), rather than thrown — keeps `runSync` callers and the exit code unaffected.
