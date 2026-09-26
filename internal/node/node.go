// Package node assembles one Athanor storage process: the local store, the
// gossiped membership and ring, the quorum coordinator, the repair jobs, and
// the gRPC peer server.
//
// A node can be stopped and started without exiting. Stop switches off
// gossip, peer RPC, and background jobs, which is what peers would see if the
// process crashed. The HTTP admin API stays up so the dashboard can start the
// node again. The store stays on disk, so a restart finds its data.
//
// Two small records ride along in the store so a process restart is not a
// step backwards: the gossiped N/W/R policy (a restarted cluster keeps the
// policy an operator set) and the clock high-water mark (a restarted node
// never issues a version older than one it already handed out).
package node

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/grpc"

	"github.com/Arjun-Walia/Athanor/internal/api/nodepb"
	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/membership"
	"github.com/Arjun-Walia/Athanor/internal/repair"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/ring"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// Config is everything one node needs to run.
type Config struct {
	ID            string
	DataDir       string
	HTTPAddr      string // listen address for client + admin HTTP
	GRPCAddr      string // listen address for peer RPC
	GossipAddr    string // bind address for memberlist
	Advertise     string // host peers use to reach this node (default: gossip IP)
	PublicURL     string // browser-facing URL of this node's HTTP API
	Seeds         []string
	Quorum        replica.Quorum
	VNodes        int
	ScrubInterval time.Duration
	ReapAfter     time.Duration
	RebalanceRate float64 // objects per second
	RPCTimeout    time.Duration
	// ClusterSecret, when set, encrypts gossip and authenticates every
	// peer RPC. Every node in a cluster must share it.
	ClusterSecret string
	Fast          bool // tighter timings for tests
	Quiet         bool // no process log output
}

// ClusterConfig is the gossiped durability policy. The newest version wins
// everywhere; ties break on origin so every node agrees.
type ClusterConfig struct {
	Quorum    replica.Quorum `json:"quorum"`
	Version   uint64         `json:"version"`
	Origin    string         `json:"origin"`
	UpdatedAt time.Time      `json:"updated_at"`
}

func (c ClusterConfig) newerThan(o ClusterConfig) bool {
	if c.Version != o.Version {
		return c.Version > o.Version
	}
	return c.Origin > o.Origin
}

// Node is one running storage process.
type Node struct {
	cfg   Config
	store *store.Disk
	log   *events.Log
	clock *replica.Clock
	local *replica.LocalPeer

	mem        *membership.Membership
	coord      *replica.Coordinator
	repairer   *repair.Repairer
	scrubber   *repair.Scrubber
	hints      *repair.HintReplayer
	rebalancer *repair.Rebalancer

	ring    atomic.Pointer[ring.Ring]
	cluster atomic.Pointer[ClusterConfig]

	// Short-lived caches for the views the dashboard polls. Several open
	// dashboards then cost one fan-out per interval, not one each.
	overview    [2]memo[Overview]
	eventsCache memo[[]events.Event]
	cacheTTL    time.Duration

	connMu sync.Mutex
	conns  map[string]*grpc.ClientConn

	lifeMu    sync.Mutex
	running   bool
	grpcSrv   *grpc.Server
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	startedAt time.Time
	bootedAt  time.Time
	restarts  int
}

// New opens the store and wires the components. Call Start to join.
func New(cfg Config) (*Node, error) {
	if cfg.ID == "" {
		return nil, errors.New("node: id is required")
	}
	if !cfg.Quorum.Valid() {
		cfg.Quorum = replica.DefaultQuorum()
	}
	if cfg.VNodes <= 0 {
		cfg.VNodes = ring.DefaultVNodes
	}
	if cfg.RPCTimeout <= 0 {
		cfg.RPCTimeout = 3 * time.Second
	}
	if cfg.ScrubInterval <= 0 {
		cfg.ScrubInterval = 30 * time.Second
	}
	st, err := store.Open(cfg.DataDir)
	if err != nil {
		return nil, err
	}

	n := &Node{
		cfg:      cfg,
		store:    st,
		log:      events.New(cfg.ID, events.DefaultCapacity, cfg.Quiet),
		clock:    &replica.Clock{},
		conns:    map[string]*grpc.ClientConn{},
		bootedAt: time.Now().UTC(),
		cacheTTL: 300 * time.Millisecond,
	}
	if cfg.Fast {
		n.cacheTTL = 20 * time.Millisecond
	}
	n.local = &replica.LocalPeer{Node: cfg.ID, Store: st, Clock: n.clock}
	n.ring.Store(ring.New([]string{cfg.ID}, cfg.VNodes, 0))

	// Restore what the last run knew. The persisted policy wins over the
	// flags when it exists: it was set on purpose, by an operator, and a
	// restart must not silently reset the cluster to its defaults.
	policy := ClusterConfig{Quorum: cfg.Quorum, Version: 0, Origin: cfg.ID}
	if raw, ok, _ := st.GetMeta(metaPolicy); ok {
		var saved ClusterConfig
		if err := json.Unmarshal(raw, &saved); err == nil && saved.Quorum.Validate() == nil {
			policy = saved
		}
	}
	n.cluster.Store(&policy)
	if v, err := st.MaxVersion(); err == nil {
		n.clock.Observe(v)
	}
	if raw, ok, _ := st.GetMeta(metaClock); ok && len(raw) == 8 {
		n.clock.Observe(binary.BigEndian.Uint64(raw))
	}
	if stats, err := st.Stats(); err == nil {
		if stats.Swept > 0 {
			n.log.Emitf(events.KindMembership, events.LevelInfo, "", "%s recovery sweep removed %d orphan file(s) left by an earlier crash", cfg.ID, stats.Swept)
		}
		if stats.IndexErrors > 0 {
			n.log.Emitf(events.KindMembership, events.LevelWarn, "", "%s index has %d record(s) that no longer decode; they are skipped", cfg.ID, stats.IndexErrors)
		}
	}

	_, grpcPort, err := splitPort(cfg.GRPCAddr)
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("node: grpc addr: %w", err)
	}
	_, httpPort, err := splitPort(cfg.HTTPAddr)
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("node: http addr: %w", err)
	}

	var gossipKey []byte
	if cfg.ClusterSecret != "" {
		k := sha256.Sum256([]byte("athanor-gossip:" + cfg.ClusterSecret))
		gossipKey = k[:]
	}
	n.mem = membership.New(membership.Config{
		NodeID:     cfg.ID,
		SecretKey:  gossipKey,
		Bind:       cfg.GossipAddr,
		Advertise:  cfg.Advertise,
		GRPCPort:   grpcPort,
		HTTPPort:   httpPort,
		PublicURL:  cfg.PublicURL,
		Seeds:      cfg.Seeds,
		ReapAfter:  cfg.ReapAfter,
		Fast:       cfg.Fast,
		Quiet:      cfg.Quiet,
		Log:        n.log,
		LocalState: n.localState,
		MergeState: n.mergeState,
		OnChange:   n.onMembershipChange,
		OnReturn:   n.onMemberReturn,
	})

	n.coord = replica.NewCoordinator(n, n.clock, n.log, cfg.RPCTimeout)
	n.repairer = repair.NewRepairer(n, n.log, cfg.RPCTimeout)
	n.coord.OnDivergence = func(key, why string) {
		n.log.Emit(events.KindRepair, events.LevelWarn, key, fmt.Sprintf("read-repair: %s (%s)", key, why), nil)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = n.repairer.Repair(ctx, key, repair.ReasonReadRepair)
	}
	n.scrubber = repair.NewScrubber(st, n.repairer.Repair, n.log, cfg.ScrubInterval)
	n.hints = repair.NewHintReplayer(st, n, n.repairer.Repair, n.log)
	n.rebalancer = repair.NewRebalancer(st, n, n.log, cfg.RebalanceRate)
	return n, nil
}

// Start brings up peer RPC, gossip, and the background jobs.
func (n *Node) Start() error {
	n.lifeMu.Lock()
	defer n.lifeMu.Unlock()
	if n.running {
		return nil
	}
	lis, err := net.Listen("tcp", n.cfg.GRPCAddr)
	if err != nil {
		return fmt.Errorf("node: grpc listen %s: %w", n.cfg.GRPCAddr, err)
	}
	srv := newGRPCServer(n)
	go func() { _ = srv.Serve(lis) }()

	if err := n.mem.Start(); err != nil {
		srv.Stop()
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	n.grpcSrv = srv
	n.cancel = cancel
	n.running = true
	n.startedAt = time.Now().UTC()
	n.onMembershipChange()

	settle, period, hintEvery := 2*time.Second, 30*time.Second, 2*time.Second
	if n.cfg.Fast {
		settle, period, hintEvery = 300*time.Millisecond, 3*time.Second, 300*time.Millisecond
	}
	n.wg.Add(3)
	go func() { defer n.wg.Done(); n.scrubber.Run(ctx) }()
	go func() { defer n.wg.Done(); n.hints.Run(ctx, hintEvery) }()
	go func() { defer n.wg.Done(); n.rebalancer.Run(ctx, settle, period) }()

	if n.restarts == 0 {
		n.log.Emit(events.KindMembership, events.LevelInfo, "",
			fmt.Sprintf("%s booted: gossip %s, peer RPC %s", n.cfg.ID, n.cfg.GossipAddr, n.cfg.GRPCAddr),
			map[string]string{"subject": n.cfg.ID, "change": "boot"})
	} else {
		n.log.Emitf(events.KindFault, events.LevelOK, "", "%s is up: gossip %s, peer RPC %s", n.cfg.ID, n.cfg.GossipAddr, n.cfg.GRPCAddr)
	}
	n.restarts++
	return nil
}

// Stop simulates a crash: no graceful leave, peers must notice by probing.
func (n *Node) Stop() {
	n.lifeMu.Lock()
	defer n.lifeMu.Unlock()
	if !n.running {
		return
	}
	n.running = false
	n.cancel()
	n.mem.Stop()
	n.grpcSrv.Stop()
	n.wg.Wait()
	n.saveClock()
	n.log.Emitf(events.KindFault, events.LevelErr, "", "%s stopped: gossip and peer RPC are off, data stays on disk", n.cfg.ID)
}

// Close stops the node and releases the store.
func (n *Node) Close() error {
	n.Stop()
	n.connMu.Lock()
	for addr, c := range n.conns {
		_ = c.Close()
		delete(n.conns, addr)
	}
	n.connMu.Unlock()
	return n.store.Close()
}

// Running reports whether gossip and peer RPC are up.
func (n *Node) Running() bool {
	n.lifeMu.Lock()
	defer n.lifeMu.Unlock()
	return n.running
}

// Ready reports whether this node can take client traffic with a fair
// chance of success: it is running and its view of the ring holds enough
// live members for a write to reach W. A load balancer or orchestrator
// should route on this, and on Health for liveness.
func (n *Node) Ready() (bool, string) {
	if !n.Running() {
		return false, "stopped"
	}
	q := n.Quorum()
	live := 0
	for _, id := range n.Members() {
		if n.Reachable(id) {
			live++
		}
	}
	switch {
	case live < q.W:
		return false, fmt.Sprintf("%d live member(s), W=%d", live, q.W)
	case q.N > 1 && n.mem.Isolated():
		return false, "no live peer yet"
	}
	return true, "ok"
}

// Restarts is how many times Start ran in this process.
func (n *Node) Restarts() int {
	n.lifeMu.Lock()
	defer n.lifeMu.Unlock()
	return n.restarts
}

const (
	metaPolicy = "cluster-policy"
	metaClock  = "clock"
)

func (n *Node) saveClock() {
	var raw [8]byte
	binary.BigEndian.PutUint64(raw[:], n.clock.Last())
	_ = n.store.PutMeta(metaClock, raw[:])
}

func (n *Node) savePolicy(cfg ClusterConfig) {
	if raw, err := json.Marshal(cfg); err == nil {
		_ = n.store.PutMeta(metaPolicy, raw)
	}
}

// ID is this node's id.
func (n *Node) ID() string { return n.cfg.ID }

// Log is this node's event log.
func (n *Node) Log() *events.Log { return n.log }

// Coordinator is the client put/get/delete path.
func (n *Node) Coordinator() *replica.Coordinator { return n.coord }

// Store is the local store.
func (n *Node) Store() *store.Disk { return n.store }

// Membership is the gossip view.
func (n *Node) Membership() *membership.Membership { return n.mem }

// --- replica.View -----------------------------------------------------------

// Self implements replica.View.
func (n *Node) Self() string { return n.cfg.ID }

// Quorum implements replica.View.
func (n *Node) Quorum() replica.Quorum { return n.cluster.Load().Quorum }

// Walk implements replica.View.
func (n *Node) Walk(key string) []string { return n.ring.Load().Walk(key) }

// Members implements replica.View.
func (n *Node) Members() []string { return n.ring.Load().Nodes() }

// Reachable implements replica.View.
func (n *Node) Reachable(id string) bool { return n.mem.Reachable(id) }

// Peer implements replica.View.
func (n *Node) Peer(id string) replica.Peer {
	if id == n.cfg.ID {
		return n.local
	}
	return &remotePeer{n: n, id: id}
}

// Ring is the current placement view.
func (n *Node) Ring() *ring.Ring { return n.ring.Load() }

// ClusterConfig is the current gossiped policy.
func (n *Node) ClusterConfig() ClusterConfig { return *n.cluster.Load() }

// SetQuorum changes the cluster-wide N/W/R and gossips it.
func (n *Node) SetQuorum(q replica.Quorum) (ClusterConfig, error) {
	if err := q.Validate(); err != nil {
		return ClusterConfig{}, err
	}
	for {
		cur := n.cluster.Load()
		next := &ClusterConfig{Quorum: q, Version: cur.Version + 1, Origin: n.cfg.ID, UpdatedAt: time.Now().UTC()}
		if n.cluster.CompareAndSwap(cur, next) {
			n.afterConfigChange(*cur, *next)
			if raw, err := json.Marshal(next); err == nil {
				n.mem.Broadcast(raw)
			}
			return *next, nil
		}
	}
}

func (n *Node) localState() []byte {
	raw, _ := json.Marshal(n.cluster.Load())
	return raw
}

func (n *Node) mergeState(raw []byte) {
	var in ClusterConfig
	if err := json.Unmarshal(raw, &in); err != nil || in.Quorum.Validate() != nil {
		return
	}
	for {
		cur := n.cluster.Load()
		if !in.newerThan(*cur) {
			return
		}
		next := in
		if n.cluster.CompareAndSwap(cur, &next) {
			n.afterConfigChange(*cur, next)
			return
		}
	}
}

func (n *Node) afterConfigChange(prev, next ClusterConfig) {
	n.savePolicy(next)
	if prev.Quorum == next.Quorum {
		return
	}
	n.log.Emit(events.KindConfig, events.LevelInfo, "",
		fmt.Sprintf("durability policy N/W/R %s → %s (set on %s)", prev.Quorum, next.Quorum, next.Origin),
		map[string]string{"n": strconv.Itoa(next.Quorum.N), "w": strconv.Itoa(next.Quorum.W), "r": strconv.Itoa(next.Quorum.R)})
	if prev.Quorum.N != next.Quorum.N {
		n.rebalancer.Kick("replication factor changed")
	}
}

func (n *Node) onMembershipChange() {
	version, digest, set := n.mem.Ring()
	cur := n.ring.Load()
	if cur.Version() == version && cur.Digest() == digest {
		return
	}
	n.ring.Store(ring.New(set, n.cfg.VNodes, version))
	if cur.Digest() != digest {
		n.rebalancer.Kick(fmt.Sprintf("ring v%d", version))
	}
}

func (n *Node) onMemberReturn(id string) {
	if m, ok := n.mem.Member(id); ok && m.GRPCAddr != "" {
		n.connMu.Lock()
		if c, ok := n.conns[m.GRPCAddr]; ok {
			c.ResetConnectBackoff()
		}
		n.connMu.Unlock()
	}
	n.hints.Kick()
}

// Block partitions this node from peer: gossip and peer RPC both stop in
// both directions from this side.
func (n *Node) Block(peer string) error {
	if peer == "" || peer == n.cfg.ID {
		return errors.New("node: pick another node to partition from")
	}
	n.mem.Block(peer)
	n.log.Emitf(events.KindFault, events.LevelWarn, "", "network between %s and %s cut (partition)", n.cfg.ID, peer)
	return nil
}

// Unblock heals the partition with peer, or all partitions if peer is "".
func (n *Node) Unblock(peer string) {
	n.mem.Unblock(peer)
	if peer == "" {
		n.log.Emitf(events.KindFault, events.LevelOK, "", "all partitions on %s healed", n.cfg.ID)
	} else {
		n.log.Emitf(events.KindFault, events.LevelOK, "", "network between %s and %s restored", n.cfg.ID, peer)
	}
	n.hints.Kick()
}

func (n *Node) partitionedFrom(peer string) bool {
	for _, b := range n.mem.Blocked() {
		if b == peer {
			return true
		}
	}
	return false
}

func splitPort(addr string) (string, int, error) {
	host, p, err := net.SplitHostPort(addr)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(p)
	if err != nil {
		return "", 0, err
	}
	return host, port, nil
}

// Secured reports whether peer RPC and gossip require the cluster secret.
func (n *Node) Secured() bool { return n.cfg.ClusterSecret != "" }

// memo caches one computed value for a short time. Callers that arrive
// while a computation is running wait for it rather than starting another,
// so a burst of identical requests costs one fan-out.
type memo[T any] struct {
	mu      sync.Mutex
	compute sync.Mutex
	at      time.Time
	val     T
	ok      bool
}

func (m *memo[T]) get(ttl time.Duration, fn func() (T, error)) (T, error) {
	m.mu.Lock()
	if m.ok && time.Since(m.at) < ttl {
		v := m.val
		m.mu.Unlock()
		return v, nil
	}
	m.mu.Unlock()

	m.compute.Lock()
	defer m.compute.Unlock()
	// Someone may have filled it while we waited for the compute lock.
	m.mu.Lock()
	if m.ok && time.Since(m.at) < ttl {
		v := m.val
		m.mu.Unlock()
		return v, nil
	}
	m.mu.Unlock()

	v, err := fn()
	if err != nil {
		return v, err
	}
	m.mu.Lock()
	m.val, m.at, m.ok = v, time.Now(), true
	m.mu.Unlock()
	return v, nil
}

// invalidate drops whatever is cached, so the next caller recomputes.
func (m *memo[T]) invalidate() {
	m.mu.Lock()
	m.ok = false
	m.mu.Unlock()
}

// compile-time interface check
var _ replica.View = (*Node)(nil)
var _ nodepb.NodeServer = (*rpcServer)(nil)
