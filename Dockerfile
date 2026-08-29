# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG CONVENE_WIRE_RELEASE_VERSION=development
ARG CONVENE_WIRE_SOURCE_COMMIT=unknown

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN npm run validate \
    && npm run build --workspace @convene-wire/server \
    && npm run build --workspace @convene-wire/web
RUN npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ARG CONVENE_WIRE_RELEASE_VERSION
ARG CONVENE_WIRE_SOURCE_COMMIT
LABEL org.opencontainers.image.revision="${CONVENE_WIRE_SOURCE_COMMIT}" \
      org.opencontainers.image.version="${CONVENE_WIRE_RELEASE_VERSION}"

# Runtime configuration belongs to Compose or the explicit container caller.
# Baking renamed defaults here would conflict with a supplied legacy alias.
ENV NODE_ENV=production

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/migrations ./apps/server/migrations
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/generated ./packages/contracts/generated
COPY --chown=node:node LICENSE NOTICE COMMERCIAL-LICENSE.md TRADEMARKS.md ./

RUN mkdir -p /data /backups && chown node:node /data /backups
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/server/dist/server.js"]
