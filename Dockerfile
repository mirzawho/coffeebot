# Cafe ordering bot — single-process Bun app (bot + HTTP + scheduler).
# SQLite data lives on a mounted volume at /data (DATABASE_PATH default).

FROM oven/bun:1-slim AS base
WORKDIR /app

# Install production dependencies only. The combined COPY with bun.lock* is
# Docker's documented pattern for an optional lockfile: non-wildcard sources
# must match; the wildcard is skipped when absent (BuildKit).
COPY package.json bun.lock* ./
RUN if [ -f bun.lock ] || [ -f bun.lockb ]; then \
      bun install --production --frozen-lockfile; \
    else \
      bun install --production; \
    fi

# Application source: bot, services, migrations, admin Mini App assets.
COPY tsconfig.json ./
COPY src ./src

# Persistent data + product image uploads live under /data.
RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun

ENV NODE_ENV=production \
    DATABASE_PATH=/data/cafe.sqlite \
    HTTP_PORT=3000 \
    TIMEZONE=Asia/Tehran \
    LOG_LEVEL=info

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.HTTP_PORT||3000}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Graceful shutdown is handled in src/index.ts (SIGTERM/SIGINT).
CMD ["bun", "run", "src/index.ts"]
