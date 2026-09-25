.PHONY: build test test-race vet lint check run cluster compose compose-public public public-down ui ui-build ui-embed ui-lint ui-test proto desktop desktop-dist install-desktop docker

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X main.version=$(VERSION)

build:
	go build -ldflags "$(LDFLAGS)" -o bin/vault-node ./cmd/vault-node

test:
	go test ./...

# What CI runs: vet, then every test under the race detector.
test-race: vet
	go test -race -count=1 ./...

vet:
	go vet ./...

# Static analysis and the known-vulnerability scan, as CI runs them.
lint: vet
	test -z "$$(gofmt -l .)"
	go run honnef.co/go/tools/cmd/staticcheck@latest ./...
	go run golang.org/x/vuln/cmd/govulncheck@latest ./...

ui-lint:
	npm --prefix ui run lint

ui-test:
	npm --prefix ui test

# Everything a reviewer would run before merging.
check: lint test-race ui-lint ui-test

# One node on its own needs N=W=R=1: a write cannot wait for replicas that
# do not exist.
run:
	go run -ldflags "$(LDFLAGS)" ./cmd/vault-node --id node1 --http :8080 --gossip 127.0.0.1:7946 --data ./data/node1 --n 1 --w 1 --r 1

# Five local processes, no Docker. Ports 8081-8085.
cluster:
	scripts/local-cluster.sh

compose:
	ATHANOR_VERSION=$(VERSION) docker compose -f deploy/docker-compose.yml up --build

# Five nodes behind one health-checking gateway, as deployed publicly.
# ATHANOR_PUBLIC_URL must be the origin visitors use.
compose-public:
	ATHANOR_VERSION=$(VERSION) docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.public.yml up --build -d

# Same public shape without Docker: five processes, a local gateway, cloudflared.
public:
	scripts/public-up.sh

public-down:
	scripts/public-down.sh

docker:
	docker build -f deploy/Dockerfile --build-arg VERSION=$(VERSION) -t athanor/vault-node:$(VERSION) .

ui:
	npm --prefix ui install
	npm --prefix ui run dev

ui-build:
	npm --prefix ui ci
	npm --prefix ui run build

# Copy the built UI next to the webui package so `go build` embeds it.
ui-embed: ui-build
	rm -rf internal/webui/dist && mkdir -p internal/webui/dist
	cp -R ui/dist/. internal/webui/dist/
	touch internal/webui/dist/.gitkeep

# Frameless dashboard window, run from this checkout.
desktop:
	npm --prefix ui run build
	npm --prefix desktop install
	npm --prefix desktop start

# Installers for this machine's OS land in desktop/dist. CI builds all three.
desktop-dist:
	npm --prefix ui run build
	npm --prefix desktop install
	npm --prefix desktop run dist

install-desktop:
	scripts/install-desktop.sh

proto:
	protoc --go_out=. --go_opt=module=github.com/Arjun-Walia/Athanor \
		--go-grpc_out=. --go-grpc_opt=module=github.com/Arjun-Walia/Athanor \
		proto/node.proto
