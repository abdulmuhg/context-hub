# Part 4 deviations

## Task 1 (Dockerfile)

- The image was not built or run locally: Docker Desktop's engine did not start
  on the PC. Steps 4 to 6 were skipped, and the first build was the CI run.
- The first CI build failed at `pnpm install`: `better-sqlite3` had no prebuilt
  binary to fetch and tried to compile without Python. Added
  `python3 make g++` to the build stage only, as the plan's fallback describes.
- `pnpm deploy --legacy` worked as written.

## Task 4 (backup script)

- Step 3, the local run against a test image, was skipped for the same reason.
  The script's first run was on the server, in Task 10.

## Task 10 (backup check)

- The plan's restore check mounted the backup file read-only and opened it
  read-only. That fails: the backup is in write-ahead mode, which needs a
  writable folder even to read. The check was run from a writable throwaway
  copy instead. Result: integrity ok, schema version 3.
