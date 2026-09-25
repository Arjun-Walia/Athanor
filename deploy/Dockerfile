# One image for every node. The dashboard and landing page are built first
# and embedded into the binary, so each node serves them at / and /app.
#
#   docker build -f deploy/Dockerfile --build-arg VERSION=$(git describe --tags --always) .

FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM golang:1.25-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=ui /ui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/vault-node ./cmd/vault-node

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 vault \
    && mkdir -p /data \
    && chown vault:vault /data
COPY --from=build --chown=vault:vault /out/vault-node /usr/local/bin/vault-node
USER vault
# 8080 client + admin HTTP, 9090 peer gRPC, 7946 SWIM gossip (TCP and UDP)
EXPOSE 8080 9090 7946/tcp 7946/udp
VOLUME ["/data"]
# Liveness for orchestrators that do not read compose healthchecks. Use
# /v1/admin/ready for routing decisions; it answers 503 while the node cannot
# reach a write quorum.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/v1/admin/health >/dev/null || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["vault-node"]
