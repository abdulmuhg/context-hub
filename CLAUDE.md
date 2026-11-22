# context-hub

Where things live:

- Health check: `GET /healthz` returns `{"ok":true,"version":...}`. There is no `/health`.
- Run the image locally: `docs/try-locally.md`. The production image's Dockerfile runs the typecheck and the full test suite.
- Plans: `docs/superpowers/plans/`. Coding standards: `docs/coding-standards.md`.
- Deploy: `.github/workflows/deploy.yml`, which deploys every push to `main`. Server config lives in `~/project/vps-stack`, not here.
