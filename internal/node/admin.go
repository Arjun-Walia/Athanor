package node

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/membership"
	"github.com/Arjun-Walia/Athanor/internal/repair"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/ring"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// ErrStopped is returned by operations that need gossip and peer RPC.
var ErrStopped = errors.New("node is stopped")

// NodeView is one member as the dashboard shows it.
type NodeView struct {
	membership.Member
	Reachable bool   `json:"reachable"`
	Counted   bool   `json:"counted"` // object/byte counts come from a live inventory
	Objects   int    `json:"objects"`
	Bytes     uint64 `json:"bytes"`
	Hints     int    `json:"hints"`
	Tampered  int    `json:"tampered"`
}

// ReplicaView is one node's copy of one object.
type ReplicaView struct {
	Node      string `json:"node"`
	Status    string `json:"status"` // ok, stale, missing, hint, tampered, unreachable, extra
	Version   uint64 `json:"version,omitempty,string"`
	HintFor   string `json:"hint_for,omitempty"`
	Preferred bool   `json:"preferred"`
}

// ObjectView is one row of the replica map.
type ObjectView struct {
	Key             string        `json:"key"`
	Size            uint64        `json:"size"`
	Version         uint64        `json:"version,string"`
	Origin          string        `json:"origin"`
	Checksum        string        `json:"checksum"`
	ContentType     string        `json:"content_type,omitempty"`
	WrittenAt       time.Time     `json:"written_at"`
	Deleted         bool          `json:"deleted"`
	Preference      []string      `json:"preference"`
	Replicas        []ReplicaView `json:"replicas"`
	Healthy         int           `json:"healthy"`
	Target          int           `json:"target"`
	UnderReplicated bool          `json:"under_replicated"`
}

// Metrics is the honest-overhead card.
type Metrics struct {
	Objects         int     `json:"objects"`
	Tombstones      int     `json:"tombstones"`
	LogicalBytes    uint64  `json:"logical_bytes"`
	PhysicalBytes   uint64  `json:"physical_bytes"`
	Overhead        float64 `json:"overhead"`
	PolicyOverhead  float64 `json:"policy_overhead"`
	UnderReplicated int     `json:"under_replicated"`
	Hints           int     `json:"hints"`
	Tampered        int     `json:"tampered"`
	Complete        bool    `json:"complete"` // every ring member answered
}

// Overview is everything the dashboard polls, gathered in one fan-out.
type Overview struct {
	Coordinator string                  `json:"coordinator"`
	Running     bool                    `json:"running"`
	RingVersion uint64                  `json:"ring_version"`
	RingDigest  string                  `json:"ring_digest"`
	Converged   bool                    `json:"converged"`
	Config      ClusterConfig           `json:"config"`
	Nodes       []NodeView              `json:"nodes"`
	Objects     []ObjectView            `json:"objects"`
	Metrics     Metrics                 `json:"metrics"`
	Scrub       repair.ScrubStatus      `json:"scrub"`
	Rebalance   repair.RebalanceSummary `json:"rebalance"`
	Repairs     repair.Stats            `json:"repairs"`
	Partitions  []string                `json:"partitions"`
	GeneratedAt time.Time               `json:"generated_at"`
}

// Health is this process's own status.
type Health struct {
	NodeID      string             `json:"node_id"`
	State       string             `json:"state"` // running or stopped
	Quorum      replica.Quorum     `json:"quorum"`
	RingVersion uint64             `json:"ring_version"`
	BootedAt    time.Time          `json:"booted_at"`
	StartedAt   time.Time          `json:"started_at"`
	Scrub       repair.ScrubStatus `json:"scrub"`
	Store       store.Stats        `json:"store"`
}

// Health reports this process's state. It answers even when stopped.
func (n *Node) Health() Health {
	st, _ := n.store.Stats()
	n.lifeMu.Lock()
	running, started := n.running, n.startedAt
	n.lifeMu.Unlock()
	state := "running"
	if !running {
		state = "stopped"
	}
	return Health{
		NodeID: n.cfg.ID, State: state, Quorum: n.Quorum(), RingVersion: n.ring.Load().Version(),
		BootedAt: n.bootedAt, StartedAt: started, Scrub: n.scrubber.Status(), Store: st,
	}
}

func (n *Node) inventories(ctx context.Context) map[string]replica.Inventory {
	members := n.Members()
	out := make(map[string]replica.Inventory, len(members))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, id := range members {
		if !n.Reachable(id) {
			continue
		}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			rctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
			defer cancel()
			inv, err := n.Peer(id).Inventory(rctx)
			if err != nil {
				return
			}
			mu.Lock()
			out[id] = inv
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return out
}

// Overview builds the cluster, replica map, and metrics from live inventories.
func (n *Node) Overview(ctx context.Context, includeDeleted bool) (Overview, error) {
	if !n.Running() {
		return Overview{}, ErrStopped
	}
	r := n.ring.Load()
	cfg := n.ClusterConfig()
	invs := n.inventories(ctx)

	ov := Overview{
		Coordinator: n.cfg.ID,
		Running:     true,
		RingVersion: r.Version(),
		RingDigest:  r.Digest(),
		Config:      cfg,
		Scrub:       n.scrubber.Status(),
		Rebalance:   n.rebalancer.Last(),
		Repairs:     n.repairer.Stats(),
		Partitions:  n.mem.Blocked(),
		GeneratedAt: time.Now().UTC(),
	}

	ov.Converged = true
	for _, m := range n.mem.Members() {
		nv := NodeView{Member: m, Reachable: n.Reachable(m.ID)}
		if inv, ok := invs[m.ID]; ok {
			nv.Counted = true
			nv.Bytes = inv.Bytes
			nv.Hints = len(inv.Hints)
			nv.Tampered = len(inv.Tampered)
			for _, o := range inv.Objects {
				if !o.Deleted {
					nv.Objects++
				}
			}
		}
		if nv.Reachable && m.InRing && m.RingDigest != "" && m.RingDigest != ov.RingDigest {
			ov.Converged = false
		}
		ov.Nodes = append(ov.Nodes, nv)
	}

	ov.Objects, ov.Metrics = buildReplicaMap(r, cfg.Quorum, invs, n.Reachable, includeDeleted)
	return ov, nil
}

func buildReplicaMap(r *ring.Ring, q replica.Quorum, invs map[string]replica.Inventory, reachable func(string) bool, includeDeleted bool) ([]ObjectView, Metrics) {
	type holding struct {
		primary  *store.ObjectMeta
		hints    []store.ObjectMeta
		tampered bool
	}
	byKey := map[string]map[string]*holding{}
	get := func(key, node string) *holding {
		if byKey[key] == nil {
			byKey[key] = map[string]*holding{}
		}
		if byKey[key][node] == nil {
			byKey[key][node] = &holding{}
		}
		return byKey[key][node]
	}
	metrics := Metrics{PolicyOverhead: float64(min(q.N, max(r.Size(), 1))), Complete: true}
	for _, id := range r.Nodes() {
		if _, ok := invs[id]; !ok {
			metrics.Complete = false
		}
	}
	for node, inv := range invs {
		tampered := map[string]bool{}
		for _, k := range inv.Tampered {
			tampered[k] = true
		}
		for i := range inv.Objects {
			m := inv.Objects[i]
			h := get(m.Key, node)
			h.primary = &m
			h.tampered = tampered[m.Key]
			if !m.Deleted {
				metrics.PhysicalBytes += m.Size
			}
		}
		for _, m := range inv.Hints {
			h := get(m.Key, node)
			h.hints = append(h.hints, m)
			metrics.Hints++
			if !m.Deleted {
				metrics.PhysicalBytes += m.Size
			}
		}
		metrics.Tampered += len(inv.Tampered)
	}

	var objects []ObjectView
	for key, holders := range byKey {
		var winner *store.ObjectMeta
		for _, h := range holders {
			cands := append([]store.ObjectMeta(nil), h.hints...)
			if h.primary != nil {
				cands = append(cands, *h.primary)
			}
			for i := range cands {
				if winner == nil || store.Newer(cands[i], *winner) {
					w := cands[i]
					winner = &w
				}
			}
		}
		if winner == nil {
			continue
		}
		pref, _ := r.Preference(key, q.N)
		inPref := map[string]bool{}
		for _, p := range pref.Nodes {
			inPref[p] = true
		}
		ov := ObjectView{
			Key: key, Size: winner.Size, Version: winner.Version, Origin: winner.Origin,
			Checksum: winner.ChecksumHex(), ContentType: winner.ContentType, WrittenAt: winner.WrittenAt,
			Deleted: winner.Deleted, Preference: pref.Nodes, Target: len(pref.Nodes),
		}
		for _, node := range r.Nodes() {
			h := holders[node]
			_, answered := invs[node]
			rv := ReplicaView{Node: node, Preferred: inPref[node]}
			switch {
			case !answered || !reachable(node):
				if !inPref[node] {
					continue
				}
				rv.Status = "unreachable"
			case h != nil && h.primary != nil:
				rv.Version = h.primary.Version
				switch {
				case h.tampered:
					rv.Status = "tampered"
				case !store.SameVersion(*h.primary, *winner):
					rv.Status = "stale"
				case !inPref[node]:
					rv.Status = "extra"
				default:
					rv.Status = "ok"
					ov.Healthy++
				}
			case h != nil && len(h.hints) > 0:
				rv.Status = "hint"
				rv.Version = h.hints[0].Version
				rv.HintFor = h.hints[0].HintedFor
			default:
				if !inPref[node] {
					continue
				}
				rv.Status = "missing"
			}
			ov.Replicas = append(ov.Replicas, rv)
		}
		ov.UnderReplicated = ov.Healthy < ov.Target
		if winner.Deleted {
			metrics.Tombstones++
			if !includeDeleted {
				continue
			}
		} else {
			metrics.Objects++
			metrics.LogicalBytes += winner.Size
			if ov.UnderReplicated {
				metrics.UnderReplicated++
			}
		}
		objects = append(objects, ov)
	}
	sort.Slice(objects, func(i, j int) bool {
		if !objects[i].WrittenAt.Equal(objects[j].WrittenAt) {
			return objects[i].WrittenAt.After(objects[j].WrittenAt)
		}
		return objects[i].Key < objects[j].Key
	})
	if metrics.LogicalBytes > 0 {
		metrics.Overhead = float64(metrics.PhysicalBytes) / float64(metrics.LogicalBytes)
	}
	return objects, metrics
}

// ClusterEvents merges this node's log with every reachable member's.
func (n *Node) ClusterEvents(ctx context.Context, limit int) []events.Event {
	if limit <= 0 {
		limit = 300
	}
	all := n.log.Since(0, limit)
	if n.Running() {
		var mu sync.Mutex
		var wg sync.WaitGroup
		for _, id := range n.Members() {
			if id == n.cfg.ID || !n.Reachable(id) {
				continue
			}
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				rctx, cancel := context.WithTimeout(ctx, time.Second)
				defer cancel()
				evs, err := (&remotePeer{n: n, id: id}).events(rctx, 0, uint32(limit))
				if err != nil {
					return
				}
				mu.Lock()
				all = append(all, evs...)
				mu.Unlock()
			}(id)
		}
		wg.Wait()
	}
	sort.SliceStable(all, func(i, j int) bool {
		if !all[i].At.Equal(all[j].At) {
			return all[i].At.Before(all[j].At)
		}
		if all[i].Node != all[j].Node {
			return all[i].Node < all[j].Node
		}
		return all[i].Seq < all[j].Seq
	})
	if len(all) > limit {
		all = all[len(all)-limit:]
	}
	return all
}

// ScrubResult is one node's manual scrub pass.
type ScrubResult struct {
	Node       string `json:"node"`
	Checked    uint64 `json:"checked"`
	Mismatches uint64 `json:"mismatches"`
	Error      string `json:"error,omitempty"`
}

// ScrubAll runs a scrub pass on every reachable member now.
func (n *Node) ScrubAll(ctx context.Context) ([]ScrubResult, error) {
	if !n.Running() {
		return nil, ErrStopped
	}
	var mu sync.Mutex
	var out []ScrubResult
	var wg sync.WaitGroup
	for _, id := range n.Members() {
		if !n.Reachable(id) {
			continue
		}
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			res := ScrubResult{Node: id}
			if id == n.cfg.ID {
				c, m, err := n.scrubber.ScrubOnce(ctx, true)
				res.Checked, res.Mismatches = uint64(c), uint64(m)
				if err != nil {
					res.Error = err.Error()
				}
			} else {
				rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				c, m, err := (&remotePeer{n: n, id: id}).scrub(rctx)
				cancel()
				res.Checked, res.Mismatches = c, m
				if err != nil {
					res.Error = err.Error()
				}
			}
			mu.Lock()
			out = append(out, res)
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Node < out[j].Node })
	return out, nil
}

// Corrupt flips a byte of key's replica on target.
func (n *Node) Corrupt(ctx context.Context, key, target string) error {
	if target == "" || target == n.cfg.ID {
		return n.corruptLocal(key)
	}
	if !n.Running() {
		return ErrStopped
	}
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return (&remotePeer{n: n, id: target}).corrupt(rctx, key)
}

// Repair runs the repair path for key with this node coordinating.
func (n *Node) Repair(ctx context.Context, key string) (repair.Report, error) {
	if !n.Running() {
		return repair.Report{}, ErrStopped
	}
	return n.repairer.Repair(ctx, key, repair.ReasonManual)
}
