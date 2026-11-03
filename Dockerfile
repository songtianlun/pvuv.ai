# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY scripts/gen-config.mjs scripts/gen-config.mjs
COPY config.example.toml ./
RUN mkdir shared
# Optional CA for managed build environments; normal Docker builds need no secret.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=secret,id=scoring_config,target=/app/config.local.toml \
    npm run config:gen && npm run typecheck && npm run typecheck:server && npm run build:server
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 SQLITE_PATH=/data/pvuv.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/shared/schema.sql ./shared/schema.sql
COPY --from=build --chown=node:node /app/workers/console/public ./workers/console/public
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.mjs"]
