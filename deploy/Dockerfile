FROM golang:1.24-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -o /out/vault-node ./cmd/vault-node

FROM alpine:3.21

RUN adduser -D -u 10001 vault \
    && mkdir -p /data \
    && chown vault:vault /data
COPY --from=build --chown=vault:vault /out/vault-node /usr/local/bin/vault-node
USER vault
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["vault-node"]
