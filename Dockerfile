# syntax=docker/dockerfile:1
FROM oven/bun:1.4.3-slim

WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY package.json index.ts ./

USER bun
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Bun.SQL reads PGPASSWORD, so load it from a Docker secret file when one is provided.
CMD ["sh", "-c", "if [ -n \"$PGPASSWORD_FILE\" ]; then PGPASSWORD=\"$(cat \"$PGPASSWORD_FILE\")\"; export PGPASSWORD; fi; exec bun index.ts"]
