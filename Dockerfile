# ── Stage 1: Build admin panel + install production deps ────────
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# better-sqlite3 ships prebuilt binaries for Node LTS; keep a toolchain for
# platforms where prebuild-install falls back to a source build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# pnpm 是包管理器；Node.js 24 是运行时
RUN npm install --global pnpm@12.4.2

# Cache layer: install deps before copying source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The shared lockfile validates patch hashes even when the docs workspace is absent.
COPY patches ./patches
COPY apps/admin-next/package.json ./apps/admin-next/
RUN pnpm install --frozen-lockfile

# Copy source and build admin panel
COPY . .
# A cached install layer looks stale next to freshly checked-out manifests;
# skip pnpm's pre-run reinstall, which fails on the docs-only patch.
# The image-service build is explicit: its dist/ must exist before the prod
# prune, whose --ignore-scripts flag (below) skips the prepare script.
RUN pnpm --config.verify-deps-before-run=false run admin:build \
    && pnpm --config.verify-deps-before-run=false run --filter @plasticwan/image-service build

# Prune devDependencies — runtime only needs production deps.
# --ignore-scripts: the workspace package's prepare runs tsc, which the prune
# is about to remove; dist/ was already built by the explicit step above.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# ── Stage 2: Runtime (Node.js 24) ───────────────────────────────
FROM node:24-bookworm-slim

# Runtime system dependencies:
#   ffmpeg / ffprobe — video sticker representative frame extraction
#   python3 + pip    — python-lottie (TGS → SVG → PNG)
#   gosu             — privilege drop in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      gosu \
      python3 \
      python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages lottie

# Non-root user
RUN groupadd --system plasticwan \
    && useradd --system --gid plasticwan --home-dir /app --shell /usr/sbin/nologin plasticwan

WORKDIR /app

# Copy built application from builder.
# packages/image-service is resolved through a workspace symlink from the root
# node_modules, so the package directory itself must ship: manifest, built
# dist/, and its own node_modules (whose relative symlinks point back into the
# copied root node_modules/.pnpm store).
COPY --from=builder --chown=plasticwan:plasticwan /app/src ./src
COPY --from=builder --chown=plasticwan:plasticwan /app/node_modules ./node_modules
COPY --from=builder --chown=plasticwan:plasticwan /app/packages/image-service/package.json ./packages/image-service/package.json
COPY --from=builder --chown=plasticwan:plasticwan /app/packages/image-service/dist ./packages/image-service/dist
COPY --from=builder --chown=plasticwan:plasticwan /app/packages/image-service/node_modules ./packages/image-service/node_modules
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin-next/dist ./apps/admin-next/dist
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin-next/LICENSE ./apps/admin-next/LICENSE
COPY --from=builder --chown=plasticwan:plasticwan /app/apps/admin-next/NOTICE ./apps/admin-next/NOTICE
COPY --from=builder --chown=plasticwan:plasticwan /app/package.json ./package.json

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data and config volume mount points
RUN mkdir -p /data /config && chown plasticwan:plasticwan /data /config

# npx-based stdio MCP servers run with an SDK-sanitized environment (HOME,
# PATH and a few other safe vars only), so the npm cache location must come
# from npm's global config instead of the environment. /data is a writable
# volume the entrypoint chowns to the runtime user on every boot.
RUN npm config set --global cache /data/.npm-cache

# PLASTICWAN_SUPERVISED is deliberately NOT set here: the image cannot know
# whether it will be run with a restart policy, and declaring supervision
# without one would offer a "restart now" button that stops the bot for good.
# The deployment sets it — see docker-compose.yml, next to `restart:`.

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["serve", "--config", "/config/config.jsonc"]
