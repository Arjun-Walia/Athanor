.PHONY: build test run cluster compose ui ui-build ui-embed proto

build:
	go build -o bin/vault-node ./cmd/vault-node

test:
	go test ./...

# One node on its own needs N=W=R=1: a write cannot wait for replicas that
# do not exist.
run:
	go run ./cmd/vault-node --id node1 --http :8080 --gossip 127.0.0.1:7946 --data ./data/node1 --n 1 --w 1 --r 1

# Five local processes, no Docker. Ports 8081-8085.
cluster:
	scripts/local-cluster.sh

compose:
	docker compose -f deploy/docker-compose.yml up --build

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

proto:
	protoc --go_out=. --go_opt=module=github.com/Arjun-Walia/Athanor \
		--go-grpc_out=. --go-grpc_opt=module=github.com/Arjun-Walia/Athanor \
		proto/node.proto
