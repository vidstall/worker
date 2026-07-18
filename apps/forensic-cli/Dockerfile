# Build context: services/worker/ (the pnpm workspace root), not this
# directory — required so pnpm can resolve the full workspace graph
# (workspace:* deps symlink to sibling packages/*). Build with:
#   docker buildx build -f services/worker/apps/forensic-cli/Dockerfile services/worker

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
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/cp-daemon/package.json apps/cp-daemon/package.json
COPY apps/forensic-cli/package.json apps/forensic-cli/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY apps/signaling/package.json apps/signaling/package.json
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
USER dvconf

# One-shot CLI, not a server: no EXPOSE/HEALTHCHECK. ENTRYPOINT (not CMD) so
# subcommands/flags pass through, e.g.:
#   docker run --rm <image> collect --rpc <url> --package <id> --out /tmp/events.jsonl
#   docker run --rm <image> report slashes --in /tmp/events.jsonl --json
ENTRYPOINT ["node", "--import", "tsx/esm", "apps/forensic-cli/src/index.ts"]
