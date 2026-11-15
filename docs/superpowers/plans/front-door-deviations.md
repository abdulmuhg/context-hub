# Front door: where the build differs from the plan

## Task 1
- Docker was available: `docker compose config` with no `.env` fails with the `HUB_DOMAIN` message; with `HUB_DOMAIN=hub.test` it prints `PUBLIC_URL: https://hub.test` and `ghcr.io/abdulmuhg/context-hub:latest`. The Dockerfile change and the CI tags were not built or run (the image build and the workflow need CI).
- The `hub-admin` shim is written with `printf` in a `RUN`, since the plan gives only its content, not how to create it.

## Task 3
- `db.test.ts` (and `digest-store.test.ts`) rewind to older schema versions by dropping later migrations' objects by hand. They now also drop the `waitlist` table (`unmigrate14`, called from `unmigrate13`), and `db.test.ts` has a small test for migration 14. The plan only mentioned a schema-version assertion, which uses `SCHEMA_VERSION` and needed no change.
