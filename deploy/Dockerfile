# One image for every node. The dashboard and landing page are built first
# and embedded into the binary, so each node serves them at / and /app.

FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=ui /ui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vault-node ./cmd/vault-node

FROM alpine:3.22
RUN adduser -D -u 10001 vault \
    && mkdir -p /data \
    && chown vault:vault /data
COPY --from=build --chown=vault:vault /out/vault-node /usr/local/bin/vault-node
USER vault
# 8080 client + admin HTTP, 9090 peer gRPC, 7946 SWIM gossip (TCP and UDP)
EXPOSE 8080 9090 7946/tcp 7946/udp
VOLUME ["/data"]
ENTRYPOINT ["vault-node"]
