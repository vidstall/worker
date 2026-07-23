# Build context: services/worker/ (the pnpm workspace root), not this
# directory — required so pnpm can resolve the full workspace graph
# (workspace:* deps symlink to sibling packages/*). Build with:
#   docker buildx build -f services/worker/apps/bot/Dockerfile services/worker
#
# Test/demo tool only (simulates a user; never touches contract role/staking
# logic) but IS IaC-deployed as a singleton control server -- see
# cli/context.py's DOCKER_SERVICES and scenario/digitalocean-sample.toml's
# single `service = "bot"` worker. The admin dashboard's BotControlPanel
# calls its HTTP API (POST/GET/DELETE /bots) to launch/list/stop sessions
# instead of anyone running `pnpm --filter bot dev` by hand.

FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY apps/bot/package.json apps/bot/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
# ffmpeg decodes the looping MP4 into raw frames at runtime; @roamhq/wrtc
# ships prebuilt native bindings for common platforms (no C++ toolchain
# needed for it here, unlike mediasoup in apps/relay's Dockerfile).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd -r dvconf && useradd -r -g dvconf -m dvconf
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=dvconf:dvconf apps/bot ./apps/bot
COPY --chown=dvconf:dvconf packages ./packages
COPY --chown=dvconf:dvconf tsconfig.base.json ./
# EventPoller/ChainEventListener persist cursors to <CWD>/.cursors/*.json
# (DATA_DIR defaults to '.') -- /app itself stays root:root even after the
# --chown COPYs above (WORKDIR created it before USER dvconf existed), so
# dvconf can't mkdir a new top-level dir there. Precreate it owned by
# dvconf or every cursor write silently EACCES-fails forever.
RUN mkdir -p /app/.cursors && chown -R dvconf:dvconf /app/.cursors
USER dvconf

EXPOSE 8095
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8095)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx/esm", "apps/bot/src/index.ts"]
