# Athanor

**A fault-tolerant distributed object store that repairs itself, and a dashboard that lets you watch it do so.**

Live at **[www.athanor.cfd](https://www.athanor.cfd)**. Upload a file, kill a node, flip a byte, and read the file back intact.

[![ci](https://github.com/Arjun-Walia/Athanor/actions/workflows/ci.yml/badge.svg)](https://github.com/Arjun-Walia/Athanor/actions/workflows/ci.yml)

## The problem

Storage that lives on one machine is only as reliable as that machine. Spread it across several and a new set of problems appears: machines crash, networks split, disks silently corrupt bytes, replicas drift apart, and every one of those failures has to be noticed and put right without a human in the loop.

The brief ([PLAN.md](PLAN.md)) asks for a system that stores, replicates, retrieves and repairs objects across independently failing nodes, and that handles all of the following: concurrent reads and writes, configurable durability, node failures, partial partitions, corruption, replica inconsistency, background rebalancing, integrity checks, metadata consistency, and automatic repair, with predictable availability and a stated storage cost.

## The answer

Athanor is five (or more) identical Go processes. Any of them accepts a client request and coordinates it.

| Problem | What Athanor does |
| --- | --- |
| Where does an object live? | Its key is hashed onto a consistent-hash ring; the next N distinct nodes clockwise own it. No central index, no Raft. |
| A node dies mid-write | The write goes to W of N owners; a hint for the missing owner is parked on the next healthy node and replayed when it returns. |
| Someone unplugs a cable | SWIM gossip (memberlist) marks the node suspect, then dead; a cut between two nodes is survived because the others still vouch for both. |
| A disk flips a byte | Every replica carries its SHA-256; every read and every scrub pass re-hashes it. A bad copy is never served and is rewritten from a good one. |
| Replicas disagree | Reads compare what came back; anything stale, missing or corrupt goes through one `Repair(key)` path, the same one the scrubber and hint replay use. |
| A node joins or leaves | Each node works out which keys it should now hold and copies at a bounded rate; a copy is dropped only after every new owner confirms it. |
| Two writers at once | Hybrid-logical-clock versions, last writer wins, ties broken by origin. Deletes are tombstones, so a stale replica cannot resurrect a key. |
| How much does it cost? | 3× storage by default, said plainly on the dashboard. N, W and R are a live slider, gossiped to every node. |

The **dashboard** (`/app`) draws the live ring, shows a replica dot per copy of every object, streams the merged repair log, and has buttons to stop a node, cut the network, and corrupt a replica. The **landing page** (`/`) explains the design with a browser-side model of the same rules. Both are one React bundle embedded in the node binary, so every node serves them. A frameless **desktop app** wraps the dashboard, with installers for macOS, Windows and Linux.

## Run it

Requirements: Go 1.25+, Node.js 20+ for the UI, Docker only for the compose route.

**Five nodes in Docker**

```bash
docker compose -f deploy/docker-compose.yml up --build
```

**Five local processes, no Docker**

```bash
make ui-embed          # build the UI into the binary
scripts/local-cluster.sh
```

Either way, open **http://localhost:8081/app**. Ports 8081 to 8085 are node1 to node5. `CLEAN=1` wipes the data first; `NODES=6` starts a sixth node so you can watch keys move onto it.

**One node** (`make run`) uses N=W=R=1. **Dashboard development**: `cd ui && npm run dev`. **Desktop**: `make desktop` to run from the checkout, `make install-desktop` to install, or download an installer from [Releases](https://github.com/Arjun-Walia/Athanor/releases).

**Public deployment**: [docs/DEPLOY.md](docs/DEPLOY.md) is the walkthrough used for www.athanor.cfd, on an Oracle Cloud VPS behind a Cloudflare Tunnel, with a systemd unit. `make compose-public` is the Docker equivalent with a health-checking gateway in front.

## The 90-second demo

The dashboard's **Demo run** card ticks these off as the matching event appears in the log.

1. **Open the dashboard.** Five nodes alive; the Nodes page draws the ring from live vnode positions.
2. **Upload a file.** The write returns after W=2 acks. Three replica dots appear.
3. **Kill a node.** Peers mark it suspect, then SWIM declares it dead.
4. **Write and read while it is down.** The write parks a hint (yellow dot); the read succeeds with R=2, marked degraded.
5. **Corrupt a replica.** The dot pulses: flipped, not yet caught.
6. **Watch it heal.** Press ▶ on the scrubber or read the object: `checksum mismatch on nodeX → healed from nodeY`.
7. **Start the node again.** It rejoins, the hint replays, the dot turns solid.
8. **Drag W from 2 to 3.** The next upload waits for three acks.

## Architecture

```
browser / desktop app / curl
        │  HTTP to any node, or to the gateway in front of all of them
        ▼
   vault-node ─ stateless coordinator ─ gRPC to peers: Replicate, GetReplica, Hint, Repair, ListReplicas, Events, Scrub
        ▼
 node1  node2  node3  node4  node5      blobs on disk + bbolt index per node
                                        memberlist (SWIM) gossip: membership, ring version, N/W/R
```

| Concern | Technique | Package |
| --- | --- | --- |
| Storage | Blobs on disk, bbolt index, tombstones, crash sweep on open, directory fsync | `internal/store` |
| Placement | Consistent-hash ring, 64 vnodes per node, computed locally from gossip | `internal/ring` |
| Replication and reads | Preference list of N, write W, read R, one retry, then hinted handoff | `internal/replica` |
| Failure detection | SWIM via memberlist, local suspicion probes, gRPC keepalives, seed rejoin after a full cut | `internal/membership` |
| Repair | One `Repair(key)`; scrubber, hint replay and rebalance around it, rate-limited | `internal/repair` |
| Node | Wires it together; gRPC server and clients; persisted policy and clock; cached views | `internal/node` |
| HTTP | Client and admin API, readiness probe, in-flight cap, SSE event stream, optional admin token | `internal/api` |

Design choices, made on purpose: ring placement rather than Raft; last-writer-wins rather than version vectors; checksums and a "keys I should hold" scan rather than Merkle trees; 3× replication rather than erasure coding.

## HTTP API

Any node answers. Keys may contain slashes. Every response names the node that produced it in `X-Athanor-Node`.

| Method | Path | Behavior |
| --- | --- | --- |
| PUT | `/v1/objects/{key}` | `201` after W acks with the acks and preference list; `503` without quorum or when the node is at its in-flight cap (`Retry-After`). |
| GET | `/v1/objects/{key}` | Newest verified version. `X-Athanor-Version`, `-Checksum`, `-Replicas`, `-Degraded` describe the read. |
| DELETE | `/v1/objects/{key}` | Tombstone write, same quorum as PUT. |
| GET | `/v1/admin/health` | Liveness, always `200`; store, scrub, event-log and readiness details. |
| GET | `/v1/admin/ready` | `200` while a write can reach W, else `503`. Route on this. |
| GET | `/v1/admin/overview` | Everything the dashboard polls. |
| GET | `/v1/admin/events` · `/events/stream` | Merged log of every reachable node, as JSON or as server-sent events. |
| GET | `/v1/admin/ring?key=` | Vnode positions and a key's placement. |
| GET, PUT | `/v1/admin/config` | Cluster N/W/R, gossiped and persisted. |
| POST | `/v1/admin/scrub` · `/repair/{key}` · `/corrupt` | Scrub every node; repair one key; flip a byte (`{"key","node"}`). |
| POST | `/v1/admin/nodes/{id}/stop` · `/start` | Crash-stop or restart any node. |
| POST, DELETE | `/v1/admin/partitions` | Cut the link `{"a","b"}`; heal every cut. |

```bash
curl -X PUT --data-binary @report.pdf localhost:8081/v1/objects/reports/q3.pdf
curl -D - localhost:8083/v1/objects/reports/q3.pdf -o /dev/null
```

Every flag has an `ATHANOR_*` environment twin. `vault-node -h` lists them; `vault-node --version` prints the build.

## Security

Off by default so a local demo is a one-liner; on with three flags. [SECURITY.md](SECURITY.md) has the full threat model.

- `--admin-token`: writes and admin actions need `Authorization: Bearer <token>`; reads, the dashboard and the stream stay open. The dashboard has a token field under the plug icon.
- `--cluster-secret`: AES-GCM gossip encryption and authenticated peer RPC; a stranger cannot join or call a node.
- `--tls-cert` / `--tls-key`: TLS on the HTTP API.

Always on: checksums on every read, bounded uploads and in-flight bodies, HTTP timeouts, panic recovery per request, a Content-Security-Policy on the pages, a sandboxed desktop renderer, and vulnerability scans in CI.

## Tests and checks

```bash
make check     # gofmt, vet, staticcheck, govulncheck, go test -race, eslint, vitest
```

Go tests cover every package; `internal/node` starts real nodes in one process (memberlist gossip and gRPC on loopback) and checks replication across nodes, hinted handoff and replay, healing through scrub and read-repair, gossiped policy changes, partial partitions, restart persistence, and that a node with the wrong secret is kept out. The UI has Vitest unit tests for its pure logic and ESLint with the accessibility rules; both surfaces pass an axe-core WCAG 2.1 AA audit with zero violations.

### Requirement → proof

| Requirement in PLAN.md | Test |
| --- | --- |
| Multi-node put/get/delete | `TestClusterReplicatesAndReadsAnywhere`, `TestDeleteWritesTombstone` |
| Configurable N/W/R | `TestClusterGossipsQuorumChange`, `TestNodeRestartKeepsPolicyAndClock` |
| SWIM failure detection | `TestClusterSurvivesStoppedNodeAndReplaysHint`, `TestRejoinsSeedsAfterEveryPeerDied` |
| Quorum read/write | `TestPutPlacesNReplicasOnThePreferenceList`, `TestWriteFailsWithoutQuorum`, `TestWriteRetriesATransientReplicaFailure` |
| Checksums on every replica | `TestPutRejectsBadChecksum`, `TestCorruptIsDetectedAndHealedBySameVersion` |
| Read-repair and scrub | `TestClusterHealsCorruptReplica`, `TestReadSkipsCorruptReplicaAndReportsDivergence`, `TestScrubFindsAndHealsLocalCorruption` |
| Hinted handoff | `TestSloppyQuorumParksHintAndReadStillWorks`, `TestHintReplayDeliversWhenTargetReturns`, `TestVerifyHintsDropsCorruptOnes` |
| Rate-limited rebalance | `TestRebalanceMovesKeysToNewOwnerAndDropsExtras`, `TestTokenBucketLimitsRate`, `TestJoinMovesAMinorityOfKeys` |
| Partitions | `TestClusterPartitionRoutesAround`, `TestBlockedPeerIsUnreachableAndListed` |
| Metadata consistency | `TestPreferenceIsDistinctAndDeterministic`, `TestNodeRestartKeepsPolicyAndClock` |
| Live repair log | `TestEventStreamPushesNewLines`, `TestRingKeepsNewestAndCounts` |
| Availability under load | `TestInflightLimitAnswers503WithRetryAfter`, `TestReadyProbe`, `TestOverviewIsCachedBriefly` |
| Security | `TestAdminTokenGatesMutations`, `TestAuthInterceptorRequiresTheClusterSecret`, `TestClusterSecretKeepsStrangersOut` |

CI runs the same pipeline, boots a node with a token and reads its event stream, builds and boots the Docker image, and packages the desktop installers (attached to the GitHub release on a `v*` tag).

## Repository layout

```
cmd/vault-node/     entry point, flags, ATHANOR_* env
internal/           store, ring, replica, membership, repair, node, api, webui
proto/              peer RPC (make proto regenerates internal/api/nodepb)
ui/                 Vite + React: landing page (/) and dashboard (/app); public/ holds icons, robots, sitemap, the social image
desktop/            Electron shell and electron-builder config
deploy/             Dockerfile, compose files, Caddyfiles, systemd unit, env example
scripts/            local-cluster.sh, public-up.sh, public-down.sh, install-desktop.sh
docs/               DEPLOY.md (Oracle Cloud VPS walkthrough)
```

## Honest limits

- **Last writer wins.** No version vectors, no siblings.
- **Tombstones are kept forever.** No garbage collection yet.
- **The event log is in memory**, 1,000 lines per node, empty after a restart. Policy and clock persist; the log does not.
- **Stop and partition are simulated inside the node** so the dashboard can undo them. `docker compose stop` is a real crash.
- **Some work scales with the whole cluster.** Rebalance compares full inventories and repair asks every member: fine for a handful of nodes and thousands of keys, not built for millions.
- **Objects are held in memory per request**, up to 64 MiB, at most 32 at a time per node.
- **The public demo runs open** so visitors can press the buttons. Do not store anything you care about on it.
- **The desktop app is unsigned.** macOS and Windows warn on first launch.
