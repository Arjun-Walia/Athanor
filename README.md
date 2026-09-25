# Athanor

Athanor is a fault-tolerant distributed object store. Independent nodes replicate objects with a Dynamo-style quorum, detect failure with SWIM gossip, and repair corruption themselves. The dashboard is there so a judge can see every replica, kill a node, and watch a bad copy heal.

The design document is [PLAN.md](PLAN.md). That document uses the working title Vault. This repository is that system. The node binary is `vault-node`.

**This commit is the project layout, not the storage engine.** Health and cluster endpoints answer. Put, Get, Delete, gossip, replication, and repair do not. Build order is Phase A through Phase E below. Do not cut the engine to finish a desktop shell.

## What the MVP stores

- Multi-node Put / Get / Delete
- Configurable N / W / R, default **3 / 2 / 2**
- SWIM failure detection (`hashicorp/memberlist`)
- Quorum reads and writes, with sloppy quorum and a simple hinted handoff
- SHA-256 on every replica, checked on read and on a periodic scrub
- One `Repair(key)` path shared by read-repair, scrub, and hint replay
- Rate-limited rebalance when a node joins or leaves
- Docker Compose topology of 5 nodes, plus kill / start / corrupt controls
- Browser dashboard: cluster health, per-object replica map, live repair log

Not in the MVP: Raft (or any central metadata cluster), Merkle anti-entropy, Reed-Solomon erasure coding, S3 compatibility, Electron, and a chaos loop that runs on its own. The metrics card will say the honest cost of the default policy: **3× storage**, not an erasure-coded figure we did not build.

## Architecture

Any node can coordinate a client call. Placement is a consistent-hash ring, computed locally from gossiped membership. There is no cluster-wide object index.

```
browser dashboard
        │  HTTP
        ▼
   any vault-node          stateless coordinator
        │  gRPC: Replicate, GetReplica, Repair, Hint, RingSnapshot
        ▼
 node1  node2  node3  node4  node5
 local disk + bbolt index
 memberlist gossip (SWIM)
```

An object key is hashed with SHA-256. The ring walks clockwise to N distinct physical nodes. That preference list is the replica set. Versions are a per-object last-writer-wins integer (node id mixed with a counter), not a version vector. Metadata consistency means a gossiped ring version: stale ring versions are ignored.

On disk, each node keeps:

```
data/<first2>/<key>     payload
index.db                bbolt: object meta + hinted-handoff queue
```

## Repository layout

```
cmd/vault-node/          node process
internal/store/          local blobs, index, hints
internal/ring/           consistent-hash placement
internal/replica/        N/W/R policy and the coordinator
internal/membership/     Alive / Suspect / Dead view
internal/repair/         Repair, scrub, rebalance
internal/api/            HTTP now, gRPC from Phase B
proto/node.proto         peer RPC contract
ui/                      Vite + React control plane
deploy/                  Dockerfile and 5-node compose file
PLAN.md                  design and phase order
```

## Requirements

- Go 1.23 or newer
- Node.js 20 or newer, for the dashboard
- Docker, for the five-node topology

## Run the scaffold

One process:

```powershell
go run ./cmd/vault-node --id node1 --http :8080 --data ./data
curl http://localhost:8080/v1/admin/health
```

Five processes:

```powershell
docker compose -f deploy/docker-compose.yml up --build
curl http://localhost:8081/v1/admin/health
```

Host ports are 8081 through 8085, one per node. Inside the network every node listens on 8080 for HTTP and records 9090 for gRPC. gRPC is not bound yet.

Dashboard:

```powershell
cd ui
npm install
npm run dev
```

Open `http://localhost:5173`. The Node field defaults to `http://localhost:8081`. Cluster, Objects, and Events are the three pages from the demo. Kill, start, and corrupt are visible and disabled until Phase C.

`make build`, `make test`, `make run`, `make compose`, and `make ui` wrap the same commands when `make` is installed.

## HTTP

| Method | Path | Scaffold behavior |
| --- | --- | --- |
| GET | `/v1/admin/health` | 200. This process is up. `mode` is `scaffold`. |
| GET | `/v1/admin/cluster` | 200. This process only. `implemented` is false. |
| GET | `/v1/admin/events` | 200. Empty log. `implemented` is false. |
| PUT, GET, DELETE | `/v1/objects/{key}` | 501 until Phase A. |

Keys may contain slashes. The coordinator does not exist yet, so none of these routes touch disk.

Responses include `Access-Control-Allow-Origin: *` so the Vite app can call a node on another port. That is for the local demo, not a locked-down deployment.

## Peer RPC

`proto/node.proto` defines `Replicate`, `GetReplica`, `Repair`, `Hint`, and `RingSnapshot`. Generate Go stubs in Phase B. Nothing calls them today.

## Target demo (about 90 seconds)

This is the judging script from the plan. It works only after Phases A–E.

1. Open the dashboard. Five nodes are green. The ring is drawn from live membership.
2. Upload `report.pdf`. The object row shows replica dots on three nodes.
3. Kill node 2. Its card goes red. Download still succeeds because R=2.
4. Corrupt node 3's file. The next get or scrub logs a checksum mismatch, then a repair from a healthy replica.
5. Start node 2. Hint replay or rebalance runs. Its dot goes green again.
6. If the Phase F slider is in, move W from 2 to 3. The next upload waits for three acks.

Success is narrower than the full plan: a judge can upload a file, kill a node, still read it, watch a corrupt replica heal, and see where every copy lives.

## Build order

| Phase | What lands | Exit test |
| --- | --- | --- |
| A. Single node | Put / Get / Delete, checksum, bbolt, HTTP | `curl` a file on one process |
| B. Quorum | memberlist, ring, gRPC replicate, N/W/R, compose | Put on node 1, get from node 3, bytes on 3 disks |
| C. Faults | Dead marking, hints, read-repair, scrub, hint replay, kill / corrupt | Stop a container and still get; corrupt a file and watch it heal |
| D. Rebalance | Rate-limited move on join or leave | New node receives keys; old node drops extras |
| E. Dashboard | Live node cards, replica dots, event log, chaos buttons | The demo script above |
| F. Polish | N/W/R slider, overhead card, this demo kept honest | Optional Electron only after the demo works |

If time runs out, keep the local store, the ring, quorum put/get, failure detection, one repair function, and the kill-node demo. Cut rebalance completeness, hint elegance, the slider, and animation before cutting the engine.

## Locked choices

- Ring placement, not Raft
- Docker Compose, five nodes
- Last-writer-wins versions, not version vectors
- Checksums plus a "keys I should hold" scan, not Merkle trees
- React in the browser. Electron is optional and last
