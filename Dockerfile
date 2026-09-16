# syntax=docker/dockerfile:1
#
# learn-assistant — production image.
#
# Three stages so the runtime layer carries neither a compiler nor a dev dependency:
#   deps    production node_modules, with better-sqlite3 compiled for THIS image
#   build   full node_modules + sources -> a production .next
#   runtime deps' node_modules + build's .next, run by an unprivileged user
#
# The node version tracks .nvmrc. Bump both together.

ARG NODE_VERSION=24

# ---------------------------------------------------------------- deps ------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# WHY a toolchain here: better-sqlite3 ships prebuilds, but only for the ABIs it was
# published against. When one is missing for this node/arch the install falls back to
# compiling — and a missing compiler turns that into a failed build rather than a slow one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

# --------------------------------------------------------------- build ------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# WHY the data root is moved off /app for the build: `next build` renders pages, and a
# render that touches the store would otherwise leave a learn.db and a session token
# baked into the image. The build's scratch root is discarded with this stage.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    LA_DATA_ROOT=/tmp/la-build-data
RUN npm run build

# ------------------------------------------------------------- runtime ------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Off by default, and deliberately. See README "The `claude` CLI in a container":
# a CLI on PATH but unauthenticated answers `--version` happily, so the app's own
# availability probe would call a provider healthy that cannot write a single lesson.
# Absent, the probe says "not installed or not on PATH", which is the truth.
ARG INSTALL_CLAUDE_CLI=false

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=31544 \
    LA_BIND_HOST=0.0.0.0 \
    LA_DATA_ROOT=/app/data \
    HOME=/home/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_CLAUDE_CLI" = "true" ]; then \
      npm install -g @anthropic-ai/claude-code && npm cache clean --force; \
    fi

# WHY --chown on the COPY rather than a `chown -R` afterwards: a recursive chown over
# node_modules rewrites every file, which writes a second full copy of the largest
# layer in the image and adds a minute to every build.
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next        ./.next
COPY --chown=node:node package.json next.config.mjs ./
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/learn-assistant-entrypoint

# `node` (uid 1000) ships with the base image and is the uid a stock linux desktop
# account already has, so the ./data bind mount is writable without a chown dance.
# A host whose account is not 1000 sets LA_UID/LA_GID — see docker-compose.yml.
RUN mkdir -p /app/data /home/node/.claude \
 && chown -R node:node /app/data /home/node

USER node
EXPOSE 31544

# `next start` answers /api/health with 401 until a page has minted this launch's token,
# so anything below 500 means the server is up and answering.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||31544)+'/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# tini reaps the zombies a provider subprocess would otherwise leave behind, and passes
# SIGTERM through so `docker compose down` is a clean shutdown rather than a 10s kill.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/learn-assistant-entrypoint"]
