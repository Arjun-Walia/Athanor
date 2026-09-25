Vault — Fault-Tolerant Distributed Object Storage



Updated plan: keep the Dynamo/SWIM architecture, shrink scope so a 36–48h hackathon can ship a real multi-node demo.



1\. Problem



Build a fault-tolerant distributed object storage system that stores, replicates, retrieves, and repairs data across independently failing nodes.



Must handle concurrent reads/writes, configurable durability, node failures, partial partitions, corruption, replica inconsistency, background rebalancing, integrity checks, metadata consistency, and automatic repair — with predictable availability and bounded recovery/storage cost.



2\. Scope



This is a distributed-systems backend: independent node processes, real RPC, replication, quorum, failure detection, repair.



The UI is a control-plane / demo dashboard on top of that backend. Engine first. UI last.



In MVP











Multi-node Put / Get / Delete







Configurable N / W / R (fixed defaults first, slider later)







SWIM failure detection







Quorum read/write







Checksums on every replica







Read-repair + periodic scrub







Hinted handoff (simple)







Rate-limited rebalance on join/leave







Docker Compose topology + kill / partition actions







Dashboard: cluster health, object replica map, live repair log



Out of MVP (mention, do not build)











Hand-rolled or Raft central metadata







Merkle-tree anti-entropy visualization







Reed-Solomon erasure coding







Full S3 compatibility







Electron packaging (browser UI is enough)







Continuous unscripted chaos beyond a toggle + buttons



3\. Architecture



Client / dashboard (HTTP)

&#x20;       │

&#x20;       ▼

Any node (stateless coordinator for client APIs)

&#x20;       │

&#x20;  gRPC between nodes

&#x20;       │

&#x20;Node1  Node2  Node3  Node4  Node5

&#x20;local disk + bbolt index

&#x20;memberlist gossip (SWIM)



Placement: consistent-hash ring (no Raft).











Each physical node owns a fixed number of virtual nodes on the ring.







Object key → SHA-256 → walk clockwise → preference list of N distinct physical nodes.







Membership + ring version gossiped via hashicorp/memberlist.







Every node computes ownership locally. No central object index.



Why not Raft metadata: extra cluster to operate, extra split-brain story, high risk under time pressure. Ring is enough to explain “metadata consistency” as gossiped membership + per-object version.



4\. Requirement → technique (MVP)















Requirement







Technique











Storage







Content-addressed blob on local disk + bbolt index (key, version, checksum, size, hinted flag)











Replication







Preference list of N nodes; client/coordinator writes N, acks after W











Retrieval







Read R replicas; return highest version whose checksum matches











Concurrent R/W







Per-object monotonic version (nodeID + counter). Last-writer-wins. No version-vector merge in MVP











Durability policy







Per-cluster (then per-bucket) N/W/R. Default 3/2/2











Node failures







memberlist; Suspect → Dead after missed probes











Partial partitions







Sloppy quorum: if a preferred node is down, write a hint to the next healthy node











Corruption







SHA-256 stored with object; verify on every read and scrub











Replica inconsistency







Read-repair: on version/checksum mismatch, push the winner to lagging replicas











Background rebalancing







On ring change, each node lists keys it should no longer / newly own; rate-limited copy + delete











Integrity verification







Scrubber goroutine walks local index, recomputes checksums











Metadata consistency







Gossiped ring + incarnation; ignore stale ring versions











Automatic repair







Single Repair(key) path used by read-repair, scrubber, and hinted-handoff replay











Availability / overhead







Bounded vnodes per node; repair/rebalance token bucket; 3× replication stated honestly



5\. Tech stack











Language: Go







RPC: gRPC (node-to-node: Replicate, GetReplica, Repair, Hint, RingSnapshot)







Gossip: hashicorp/memberlist







Local store: filesystem blobs + bbolt







HTTP API on each node: /v1/objects, /v1/admin/health, /v1/admin/cluster, WebSocket or SSE /v1/admin/events







Demo topology: docker-compose, 5 containers, named volumes







UI: React + Vite in the browser. Electron only if time left after a working demo







Chaos: compose stop / start; optional iptables or extra compose network for partition



6\. Data model



ObjectMeta {

&#x20; key            string

&#x20; version        uint64        // (logical clock: (node\_incarnation << 32) | local\_seq) or simple cluster-wide seq per key

&#x20; checksum       \[32]byte      // SHA-256 of payload

&#x20; size           uint64

&#x20; origin         nodeID

&#x20; hinted\_for     nodeID        // empty if this is a primary replica

}



NodeState { id, addr, status: Alive|Suspect|Dead, vnodes \[], ring\_version }



On-disk layout per node:



data/<first2>/<key>          # payload

index.db                     # bbolt: meta + hinted queue



7\. Core algorithms (keep small)



Put(key, body)











Compute preference list from current ring.







Hash body → checksum. Assign version = max(seen)+1 on coordinator or local clock.







Parallel Replicate to first N reachable nodes (sloppy: skip Dead, append next Alive).







Return 201 when W acks arrive; else 503.







Record hints for skipped preferred nodes.



Get(key)











Parallel GetReplica from first R reachable of preference list (plus known hint holders if needed).







Pick highest version with valid checksum.







If any replica disagrees or is missing, async Repair(key).







Return payload.



Repair(key) — only repair implementation











Fetch metas from preference list + hint nodes.







Winner = max version with matching checksum of payload.







Push winner to every preferred node that is Alive and not holding it.







Drop stale/corrupt copies. Replay hints when target returns.



Scrub











Every T seconds, walk local index, rehash files. On mismatch, Repair(key).



Rebalance











On member join/leave, increment ring\_version.







Each node: keys I store vs keys I should store. Copy out / pull in with a global rate limit (e.g. N objects or X MB/s).



8\. Build phases



Scale to actual hours. Protect order.



Phase A — Single node (\~20%)











Put / Get / Delete







Checksum + bbolt index







HTTP API







Unit tests on store



Exit: curl put/get a file on one process.



Phase B — Multi-node quorum (\~25%)











memberlist join







Ring + preference list







gRPC Replicate / GetReplica







N/W/R writes and reads







docker-compose 5 nodes



Exit: put on node1, get from node3; data on 3 disks.



Phase C — Faults (\~25%)











Mark Dead, sloppy write + hint







Read-repair







Scrubber







Replay hints on node up







Admin: kill / start via compose wrappers or node “suicide” endpoint



Exit: stop a container, get still works; corrupt a file, next get or scrub heals it.



Phase D — Rebalance (\~10%)











Join 6th node or restart dead node







Rate-limited move







Event log lines: migrate key X from n2 → n5



Exit: new node receives some keys; old node drops extras.



Phase E — Dashboard (\~15%)











Cluster page: node cards, ring circle, N/W/R







Objects page: key, size, version, replica dots, checksum badge







Events page: append-only repair/rebalance/fail log







Buttons: Kill node, Start node, Corrupt replica (calls an admin endpoint that flips a byte)



Phase F — Polish (\~5%)











Default 3/2/2 plus live slider wired to cluster config







Metrics card: storage overhead 3.0×, last repair ms, objects under-replicated







One-page README + 90-second demo script







Optional: wrap UI in Electron



9\. Differentiators (only two)











Make the invisible visible — replica map per object + live event log + kill/corrupt buttons during judging.







Honest durability numbers — N/W/R slider (after quorum works) and a card that states 3× overhead vs what EC would be. No EC implementation.



Cut: Merkle viz, S3, chaos monkey on a timer, crypto audit trail.



10\. Demo script (90 seconds)











Open dashboard. Five green nodes. Ring drawn.







Upload report.pdf. Object row shows dots on n1 n2 n3.







Kill n2. Card goes red. Download still succeeds (R=2).







Corrupt n3’s file via button. Scrub or next GET: log checksum mismatch n3 → repaired from n1.







Start n2. Hint replay / rebalance lines appear. n2 dot goes green again.







Drag W from 2 to 3. Next upload waits for three acks (optional if slider done).



11\. Scope-cut order if time dies











Keep: local store, ring, quorum put/get, failure detection, one repair function, kill-node demo.







Cut: rebalance completeness, hinted handoff elegance, slider, animations.







Cut last: dashboard beyond health list + event log.



Never cut the engine to finish Electron.



12\. Locked decisions











Ring-based placement, not Raft







docker-compose, 5 nodes







Differentiators: replica map + event log + kill/corrupt; N/W/R slider if time







Erasure coding: not in MVP; mention on metrics card







Versions: LWW integer, not full version vectors







Anti-entropy: checksum + “keys I should hold” scan, not Merkle trees







UI: React in browser first



13\. Repo layout



vault/

&#x20; cmd/vault-node/main.go

&#x20; internal/

&#x20;   store/

&#x20;   ring/

&#x20;   replica/

&#x20;   membership/

&#x20;   repair/

&#x20;   api/          # HTTP + gRPC

&#x20; proto/

&#x20; ui/             # Vite React

&#x20; deploy/docker-compose.yml

&#x20; plan.md

&#x20; README.md



14\. Success bar



Judges can upload a file, kill a node, still read it, watch a corrupt replica heal, and see where every copy lives. That is a working Vault. Everything else is extra.

