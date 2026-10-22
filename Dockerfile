# syntax=docker/dockerfile:1

# Build for linux/amd64, the VPS's platform. better-sqlite3 is a native module;
# an image built for another platform starts and then dies on first query.

# ---------------------------------------------------------------------------
# Stage 1: build and test
# ---------------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Matches the pnpm major that wrote pnpm-lock.yaml.
RUN npm install -g pnpm@11

# better-sqlite3 publishes no prebuilt binary that this install can fetch, so it
# compiles from source and needs a toolchain. Build stage only: the runtime
# stage below copies the compiled module and carries none of this.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN pnpm install --frozen-lockfile

# Both gates run before anything ships, so a regression fails the build
# instead of reaching the server. There is no separate test job in CI.
RUN pnpm run typecheck
RUN pnpm test

RUN pnpm --filter @context-hub/server build

# The collector's single-file bundle, which the server hands out as /hub.mjs.
# Built before `deploy` below: after it, the workspace is in a production-only
# state and any further pnpm command tries to reinstall (and fails without a TTY).
ARG HUB_VERSION=dev
RUN HUB_VERSION=$HUB_VERSION pnpm --filter @context-hub/collector build

# A self-contained copy of the server with production dependencies only,
# real files instead of pnpm's symlinks. --legacy keeps the pre-pnpm-10
# behaviour, which needs no workspace injection settings.
RUN pnpm --filter @context-hub/server deploy --prod --legacy /runtime \
 && cp -r apps/server/dist /runtime/dist \
 && mkdir -p /runtime/client \
 && cp apps/collector/dist/bin.js /runtime/client/hub.mjs

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/package.json ./package.json
COPY --from=build /runtime/dist ./dist
COPY --from=build /runtime/client ./client

# Fail the image build, not the live container, if the native module is
# missing, built for the wrong platform, or lacks full-text search.
RUN node -e "import('better-sqlite3').then((m) => { const d = new m.default(':memory:'); d.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); d.close(); })"

# The database lives on a volume. Create the mount point owned by the
# unprivileged user first; a new named volume copies that ownership.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV PORT=3000
ENV DATABASE_PATH=/data/hub.sqlite
EXPOSE 3000

USER node
CMD ["node", "--enable-source-maps", "/app/dist/main.js"]
