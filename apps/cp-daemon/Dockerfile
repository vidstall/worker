# Build context: services/worker/ (the pnpm workspace root), not this
# directory — required so pnpm can resolve the full workspace graph
# (workspace:* deps symlink to sibling packages/*). Build with:
#   docker buildx build -f services/worker/apps/cp-daemon/Dockerfile services/worker

FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS deps
# mediasoup (used by relay/validator-daemon) needs a native build toolchain;
# every image installs the whole workspace lockfile in one shot, so every
# Dockerfile needs this even if this particular app doesn't import mediasoup.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY apps/cp-daemon/package.json apps/cp-daemon/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY apps/validator-daemon/package.json apps/validator-daemon/package.json
COPY packages/chain-event-listener/package.json packages/chain-event-listener/package.json
COPY packages/health-monitor/package.json packages/health-monitor/package.json
COPY packages/inter-relay-client/package.json packages/inter-relay-client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd -r dvconf && useradd -r -g dvconf -m dvconf
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=dvconf:dvconf apps ./apps
COPY --chown=dvconf:dvconf packages ./packages
COPY --chown=dvconf:dvconf tsconfig.base.json ./
# EventPoller/ChainEventListener persist cursors to <CWD>/.cursors/*.json
# (DATA_DIR defaults to '.') -- /app itself stays root:root even after the
# --chown COPYs above (WORKDIR created it before USER dvconf existed), so
# dvconf can't mkdir a new top-level dir there. Precreate it owned by
# dvconf or every cursor write silently EACCES-fails forever.
RUN mkdir -p /app/.cursors && chown -R dvconf:dvconf /app/.cursors
USER dvconf

EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CP_HEALTHZ_PORT||8091)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx/esm", "apps/cp-daemon/src/index.ts"]
