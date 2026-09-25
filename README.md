# Athanor

Athanor is a fault-tolerant distributed object store. Independent nodes replicate objects with a Dynamo-style quorum, detect failure with SWIM gossip, and repair corruption themselves. The dashboard lets you see every replica, kill a node, and watch a bad copy heal. A public cluster runs at **[www.athanor.cfd](https://www.athanor.cfd)**.

The design document is [PLAN.md](PLAN.md). It uses the working title Vault, and the node binary is still called `vault-node`. Every phase in the plan (A to F) is built, including the desktop app.

## Run it

**With Docker** (five nodes, each with its own disk):

```bash
docker compose -f deploy/docker-compose.yml up --build
```

Open **http://localhost:8081/app**. Every node serves the dashboard and the landing page, so ports 8081 to 8085 all work, and any node can coordinate any request.

**Without Docker** (five local processes, same ports):

```bash
make ui-embed        # build the dashboard into the binary (needs Node.js 20+)
scripts/local-cluster.sh
```

`CLEAN=1` wipes `./data/local` first. `NODES=6` starts a sixth node too. The script waits for node1's readiness probe before it prints the dashboard link. Stopping the script with Ctrl-C stops every node.

**Dashboard development:** run `cd ui && npm install && npm run dev`, then open http://localhost:5173/app. The dev server talks to `http://localhost:8081` by default. The plug icon in the top bar switches to another node.

**Desktop app** (frameless, full screen, installable):

Download the installer for your OS from [GitHub Releases](https://github.com/Arjun-Walia/Athanor/releases): a `.dmg` for macOS (universal), an `.exe` for Windows, an `AppImage` or `.deb` for Linux. The app looks for a cluster on localhost first and falls back to the public one, so it works out of the box. To build it from this checkout instead:

```bash
make install-desktop   # builds, installs for the current user, opens it
make desktop           # runs it from the checkout without installing
make desktop-dist      # installers for this machine's OS, in desktop/dist
```

The macOS build is not code-signed; the first launch needs right-click → Open. `ATHANOR_BASE=http://host:port` changes the fallback cluster.

**Public deployment** (one origin, five nodes, a health-checking gateway):

```bash
ATHANOR_PUBLIC_URL=https://www.athanor.cfd \
  docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.public.yml up -d --build
```

Point the tunnel or DNS at port 8080 of the host (`ATHANOR_GATEWAY_PORT` changes it). The gateway round-robins across the nodes and drops any node whose `/v1/admin/ready` answers 503, so stopping a node from the dashboard never takes the site down.

**One process:** `make run` starts a single node with N=W=R=1. A write cannot wait for replicas that don't exist.

Requirements: Go 1.25+, Node.js 20+ for the UI and desktop app, and Docker for compose.

## The 90-second demo

The dashboard's **Demo run** card ticks each step off as the matching event appears in the cluster log. The landing page has a browser-only model of the same steps under **Break it**.

1. **Open the dashboard.** Five nodes are alive, and the Nodes page draws the ring from live vnode positions.
2. **Upload a file** (Objects → Upload). The write returns after W=2 acks. The row shows a replica dot on each of its three owners.
3. **Kill a node** (Nodes → Stop). Peers first mark it *suspect* after missed direct probes, and SWIM then declares it *dead*. Its card is hatched and red.
4. **Write and read while it is down.** The write lands on the next healthy node as a **hint**, shown as a yellow dot. The read succeeds with R=2 and is marked *degraded*.
5. **Corrupt a replica** (row menu → flip a byte on a node). The dot pulses red: flipped, not yet caught.
6. **Watch it heal.** Press ▶ on the Scrubber dial, or read the object. The log shows `checksum mismatch on nodeX → healed from nodeY`.
7. **Start the node again.** It rejoins through its seeds, the hint replays, and its dot turns solid.
8. **Drag W from 2 to 3** on the Durability page. The change is gossiped to every node, and the next upload waits for three acks.

To watch rebalance, start a sixth node: `docker compose -f deploy/docker-compose.yml --profile scale up -d node6`, or `NODES=6` with the local script. The log shows lines like `rebalance: migrate docs/PLAN.md from node1 → node6` and `dropped … owners are now [...]`.

## Architecture

```
browser (landing page at /, dashboard at /app), desktop app, curl
        │  HTTP, any node (or the gateway in front of all of them)
        ▼
   vault-node  ── stateless coordinator for client calls
        │  gRPC: Replicate, GetReplica, Hint, Repair, ListReplicas, Events, Scrub, Corrupt, RingSnapshot
        ▼
 node1  node2  node3  node4  node5
 blobs on disk + bbolt index        memberlist (SWIM) gossip: membership, ring version, N/W/R
```

- **Placement.** A consistent-hash ring with 64 virtual nodes per node. A key's SHA-256 is its ring position. Walking clockwise to N distinct nodes gives the preference list, and the nodes after that are sloppy-quorum fallbacks. Every node computes this locally from gossiped membership. There is no central index and no Raft.
- **Writes.** Every write gets a hybrid-logical-clock version. The coordinator sends it to all N owners in parallel and answers `201` after W acks. A `503` means quorum was not reached. An owner whose first answer is an error is asked once more after a short pause (a redial after a peer restart); if that fails too, the next healthy node on the ring stores a **hint** for it. Deletes are tombstone writes, so a stale replica cannot resurrect a key.
- **Reads.** Ask the N owners, or a fallback for any owner that is down. Wait for R answers and return the newest version whose bytes verify. If an owner answered missing, stale, or corrupt, read-repair starts.
- **One repair path.** Read-repair, the scrubber, and hint replay all call `Repair(key)`. It asks every reachable member what it holds and picks the newest version with a matching checksum. It re-verifies the winner's bytes, then pushes them to every live owner that lacks them.
- **Failure detection.** memberlist runs SWIM: probes, indirect probes through other members, suspicion, and gossiped death. *Suspect* in the UI is this node's own observation: a peer missed direct probes but gossip hasn't declared it dead. gRPC keepalives catch a peer that vanished without closing its sockets. A dead node stays in the ring, covered by hints, for `--reap-after` (2 minutes). After that it is removed and its keys are re-replicated.
- **Rejoin.** A node that sees no live peer at all (a full cut, or the lone survivor of a restart) knocks on its seeds every few seconds until the cluster is back. memberlist alone would wait forever.
- **Rebalance.** When the ring version changes, and every 30 seconds as anti-entropy, each node checks the keys it holds. It copies them to any owner that lacks them, limited by a token bucket. It drops its own copy only after every owner confirms it holds the same or a newer version.
- **Integrity.** Every replica is stored with its SHA-256 and re-hashed on every read and on every scrub pass (`--scrub-interval`, 30 seconds). Parked hints are re-hashed too; a corrupt hint is dropped rather than replayed. Payloads are written to a temporary file, fsynced, renamed into place, and the directory is fsynced, before the index points at them. On startup the store sweeps out files the index does not reference (temporaries and superseded versions left by a crash) and skips index records that no longer decode instead of refusing to start.
- **Metadata consistency.** The ring version and member set are gossiped in node metadata. A node adopts a higher version for the same member set and ignores stale ones. The N/W/R policy also travels by gossip, and the newest version wins. Each node also writes the policy and its clock high-water mark to its index, so a full restart keeps the policy an operator set and never hands out a version older than one already issued.
- **Staying up under load.** Object bodies are held in memory per request, so each node caps how many it holds at once (`--max-inflight`, 32) and answers `503` with `Retry-After` beyond that. A panic in one request answers `500` for that request and is logged; the process stays up. HTTP has header, body, and idle timeouts; SIGTERM drains for `--shutdown-timeout`.

### Requirement → where it lives

| Requirement | Technique | Code |
| --- | --- | --- |
| Storage | Blobs on disk + bbolt index (key, version, checksum, size, hint target); crash sweep on open | `internal/store` |
| Replication, retrieval | Preference list of N, write W, read R, one retry before falling back | `internal/replica` |
| Concurrent reads and writes | Hybrid-logical-clock versions, last writer wins, ties broken by origin; clock persisted | `internal/replica/clock.go`, `store.Newer` |
| Node failures | SWIM via memberlist, local suspicion from direct probes, gRPC keepalives, seed rejoin | `internal/membership`, `internal/node/rpc.go` |
| Partial partitions | Sloppy quorum + hinted handoff; SWIM indirect probes keep partitioned nodes alive | `internal/replica`, `internal/membership/transport.go` |
| Corruption, integrity | SHA-256 per replica and per hint, verified on read and by the scrubber | `internal/store`, `internal/repair` |
| Replica inconsistency, automatic repair | One `Repair(key)` for read-repair, scrub, and hint replay | `internal/repair/repair.go` |
| Background rebalancing | "Keys I should hold" pass, rate-limited | `internal/repair/background.go` |
| Metadata consistency | Gossiped ring version + member-set digest; policy persisted per node | `internal/membership`, `internal/ring`, `internal/node` |
| Availability / overhead | Bounded vnodes, in-flight cap, readiness probe, 3× storage stated plainly | `internal/api`, dashboard overhead card |

On-disk layout per node:

```
blobs/<first2>/<sha256(key)>.<version>           primary replica
hints/<target>/<first2>/<sha256(key)>.<version>  hinted handoff waiting for <target>
index.db                                         bbolt: object meta, hint queue, policy, clock
```

## HTTP API

Any node answers. Keys may contain slashes. Every response carries `X-Athanor-Node`, the node that produced it.

| Method | Path | Behavior |
| --- | --- | --- |
| PUT | `/v1/objects/{key}` | Write. `201` after W acks, with the acks, hints, and preference list. `503` without quorum, or with `Retry-After` when the node is holding `--max-inflight` bodies. |
| GET | `/v1/objects/{key}` | Read R replicas. The body is the newest verified version. `X-Athanor-Version`, `-Checksum`, `-Replicas`, and `-Degraded` describe the read. |
| DELETE | `/v1/objects/{key}` | Tombstone write, same quorum as PUT. |
| GET | `/v1/admin/health` | Liveness. Answers `200` while the node is stopped on purpose, with `ready`, `restarts`, store and event-log counters. |
| GET | `/v1/admin/ready` | Readiness. `200` while a write from this node can reach W, else `503` with a reason. Load balancers route on this. |
| GET | `/v1/admin/cluster` | Gossiped members, ring version, and partitions. |
| GET | `/v1/admin/overview` | Everything the dashboard polls: members, the replica map, metrics, scrub state. |
| GET | `/v1/admin/objects` | Replica map + metrics. |
| GET | `/v1/admin/ring?key=` | Vnode positions, plus a key's preference list and fallbacks. |
| GET | `/v1/admin/events` | Merged event log of every reachable node. |
| GET, PUT | `/v1/admin/config` | Cluster N/W/R, for example `{"n":3,"w":3,"r":2}`. Gossiped to every node and persisted on each. |
| POST | `/v1/admin/scrub` | Scrub every reachable node now. Reports replicas and hints checked. |
| POST | `/v1/admin/repair/{key}` | Run `Repair(key)` now. |
| POST | `/v1/admin/corrupt` | Flip one byte of a replica: `{"key":"…","node":"node3"}`. |
| POST | `/v1/admin/nodes/{id}/stop` · `/start` | Crash-stop or restart any node, through that node's own admin API. |
| POST, DELETE | `/v1/admin/partitions` | Cut the link `{"a":"node1","b":"node3"}`, or heal every partition. |

```bash
curl -X PUT --data-binary @report.pdf -H 'Content-Type: application/pdf' localhost:8081/v1/objects/reports/q3.pdf
curl -D - localhost:8083/v1/objects/reports/q3.pdf -o /dev/null
```

Every flag has an `ATHANOR_*` environment variable twin (`--public-url` is `ATHANOR_PUBLIC_URL`); a flag on the command line wins. `vault-node --version` prints the build version.

Peer RPC is in [proto/node.proto](proto/node.proto). The generated Go is committed, and `make proto` regenerates it.

## Repository layout

```
cmd/vault-node/          process entry point, flags and ATHANOR_* env
internal/store/          blobs, bbolt index, hints, tombstones, crash sweep
internal/ring/           consistent-hash placement
internal/replica/        quorum policy, HLC versions, the coordinator
internal/membership/     memberlist wrapper, suspicion, rejoin, partition filter
internal/repair/         Repair, scrubber, hint replay, rebalance, token bucket
internal/node/           wires a node together; gRPC server and clients; admin views
internal/api/            HTTP API; nodepb/ is generated gRPC
internal/webui/          embeds the built UI (make ui-embed)
ui/                      Vite + React: landing page (/) and dashboard (/app)
desktop/                 Electron shell and electron-builder config
deploy/                  Dockerfile, compose topology, public overlay with a gateway
scripts/                 local-cluster.sh, install-desktop.sh
```

## Tests

```bash
make test-race
```

Unit tests cover the store (including the crash sweep, damaged index records, and corrupt hints), ring, quorum coordinator (including the retry), repair jobs, the event log, and membership (a node rejoins its seeds after every peer died). `internal/node` starts five real nodes in one test binary, with memberlist gossip and gRPC on loopback. It checks:

- A put on one node is read from another.
- A stopped node is declared dead, a hint is parked for it, and the hint replays when it returns.
- A corrupt replica heals through both the scrubber and read-repair.
- N/W/R changes reach every node by gossip.
- A partial partition does not get a node declared dead.
- A restarted node keeps the cluster policy and never issues an older version.

CI runs vet and the race tests, boots a node and round-trips an object, builds the UI, builds and boots the Docker image, and packages the desktop app for macOS, Windows and Linux. On a `v*` tag the installers are attached to the GitHub release.

## Honest limits

- **No authentication or TLS.** Anyone who can reach a node can stop nodes and flip bytes. The public cluster is a demo; do not store anything you care about on it.
- **Storage cost is 3× by default.** Reed–Solomon erasure coding would cost about 1.5× for similar fault tolerance. It is not built.
- **Last writer wins.** Concurrent writes to one key keep the one with the higher hybrid-clock version. There are no version vectors and no siblings.
- **Tombstones are kept forever.** There is no tombstone garbage collection.
- **Event logs are in memory,** 1,000 lines per node, and start empty after a process restart. The policy and clock survive; the log does not.
- **Stop and partition are simulated in the node.** Stop turns off gossip and peer RPC but leaves the admin API up, so the dashboard can start the node again. Partition drops gossip packets and refuses peer RPC between two nodes. `docker compose stop` is a real crash.
- **Some work scales with the whole cluster.** Rebalance compares full inventories, and repair asks every reachable member. That is fine for a handful of nodes and thousands of keys, but it is not built for millions.
- **Objects are held in memory per request,** up to 64 MiB, and at most 32 at a time per node.
- **The desktop app is unsigned.** macOS and Windows will warn on first launch.

## Locked choices

- Ring placement, not Raft
- Docker Compose, five nodes
- Last-writer-wins versions, not version vectors
- Checksums plus a "keys I should hold" scan, not Merkle trees
- React in the browser, wrapped by Electron for the desktop
