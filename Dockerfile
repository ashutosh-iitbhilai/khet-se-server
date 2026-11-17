# Khet Se API — production image
# Build:  docker build -t khet-se-api ./server
# Run:    docker run --env-file server/.env -p 5000:5000 khet-se-api

# ── Dependencies (dev deps needed to compile TypeScript) ──
FROM node:20-alpine AS deps
WORKDIR /app
# mongodb-memory-server is a test-only dev dependency; don't download a MongoDB binary here.
ENV MONGOMS_DISABLE_POSTINSTALL=1
COPY package.json package-lock.json ./
RUN npm ci

# ── Build, then drop dev dependencies ──
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime ──
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=5000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:5000/api/health >/dev/null || exit 1
# Index changes are applied explicitly (autoIndex is off in production):
#   docker run --rm --env-file server/.env khet-se-api node dist/scripts/sync-indexes.js
CMD ["node", "dist/server.js"]
