.PHONY: build test run compose ui

build:
	go build -o bin/vault-node ./cmd/vault-node

test:
	go test ./...

run:
	go run ./cmd/vault-node --id node1 --http :8080 --data ./data

compose:
	docker compose -f deploy/docker-compose.yml up --build

ui:
	npm --prefix ui install
	npm --prefix ui run dev
