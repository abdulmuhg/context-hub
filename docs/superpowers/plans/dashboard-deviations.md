# Dashboard deviations

- Task 1 — the "migration 4" test in db.test.ts now asserts `SCHEMA_VERSION >= 4` instead of `=== 4`, and the upgrade test in digest-store.test.ts also drops the three new tables when rewinding to version 1 — both replay or pin older schema versions, so migration 5 broke them (same fix Part 5 used).
