# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1 — build native deps (better-sqlite3) on a full toolchain image
###############################################################################
FROM node:20-bookworm-slim AS build

ENV NODE_ENV=production \
    npm_config_loglevel=warn

# better-sqlite3 needs python + build-essential to compile its native bindings
# the first time on a given arch. Once compiled, the artifact is copied to the
# runtime stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

###############################################################################
# Stage 2 — slim runtime image
###############################################################################
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/data/uptime.sqlite

# iputils-ping: needed for the ICMP / "ping" monitor type
# tini: PID 1, forwards signals, reaps zombies — small and battle-tested
# ca-certificates: TLS trust store for outbound HTTPS probes
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      iputils-ping \
      tini \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app /app

RUN mkdir -p /data /app/logs \
 && chown -R node:node /data /app

USER node

VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
