# The engine image. Small and quick to boot, deliberately: this container is
# the thing a firm opens precisely when everything else is broken.
FROM node:22-alpine AS ui-builder
WORKDIR /build/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:22-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# docker-cli + compose plugin: the engine's whole job is driving the daemon
# through the mounted socket. pg_dump arrives with the backup work (phase 5).
RUN apk add --no-cache docker-cli docker-cli-compose bash
WORKDIR /app
COPY --from=builder /build/node_modules node_modules
COPY --from=builder /build/dist dist
COPY --from=ui-builder /build/ui/dist ui/dist
COPY package.json ./

# Unprivileged, with the docker group added at run time by group_add or by the
# installer reading the socket's gid — the same arrangement the panel used.
ENV NODE_ENV=production ENGINE_STATE_DIR=/var/lib/qanoontech-engine
EXPOSE 8080
VOLUME /var/lib/qanoontech-engine
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/cli.js", "serve"]
