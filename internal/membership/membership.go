// Package membership is the SWIM failure-detector view, built on
// hashicorp/memberlist.
//
// memberlist runs the protocol: randomized probes, indirect probes through
// other members, suspicion, and dead declarations spread by gossip. This
// package keeps the application's view of it: every member ever seen, its
// gRPC and HTTP addresses (from gossiped node metadata), and which members
// form the placement ring.
//
// Status comes from two sources. Dead comes from memberlist, once SWIM's
// suspicion timeout expires. Suspect is this node's own observation: the
// member is still alive according to gossip, but it has missed consecutive
// direct probes from here. That is what a partial partition looks like:
// SWIM's indirect probes keep the member alive, and it is still unreachable
// from this node.
//
// Dead members stay in the ring (their keys are covered by hinted handoff)
// until they have been dead for ReapAfter. Removing them bumps the ring
// version, and rebalance re-replicates their keys. The ring version is
// gossiped in node metadata. A node adopts a peer's higher version for the
// same member set and ignores stale ones.
package membership

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/memberlist"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/ring"
)

// Status is the failure-detector state of one member.
type Status string

const (
	StatusAlive   Status = "alive"
	StatusSuspect Status = "suspect"
	StatusDead    Status = "dead"
	// StatusUnknown is a member remembered from before this process
	// restarted its gossip layer and not yet heard from again.
	StatusUnknown Status = "unknown"
	// StatusStopped is only ever this node's own status, while its gossip
	// and peer RPC are switched off by the fault-injection control.
	StatusStopped Status = "stopped"
)

// Member is the locally observed view of one cluster member.
type Member struct {
	ID          string    `json:"id"`
	Status      Status    `json:"status"`
	Self        bool      `json:"self"`
	InRing      bool      `json:"in_ring"`
	Partitioned bool      `json:"partitioned"`
	GossipAddr  string    `json:"gossip_addr"`
	GRPCAddr    string    `json:"grpc_addr"`
	HTTPAddr    string    `json:"http_addr"`
	PublicURL   string    `json:"public_url,omitempty"`
	RingVersion uint64    `json:"ring_version"`
	RingDigest  string    `json:"ring_digest"`
	Since       time.Time `json:"since"`
}

// Meta is what every node gossips about itself (memberlist caps it at 512
// bytes).
type Meta struct {
	GRPC        string `json:"g"`
	HTTP        string `json:"h"`
	URL         string `json:"u,omitempty"`
	RingVersion uint64 `json:"rv"`
	RingDigest  string `json:"rd"`
}

// Config configures one node's membership.
type Config struct {
	NodeID    string
	Bind      string // gossip host:port; host 0.0.0.0 advertises a private IP
	Advertise string // optional host other nodes should use to reach this one
	GRPCPort  int
	HTTPPort  int
	PublicURL string
	Seeds     []string
	ReapAfter time.Duration
	Fast      bool // tighter SWIM timings, for tests
	Quiet     bool // drop memberlist's own log lines
	Log       *events.Log

	// Cluster-wide settings ride on gossip: LocalState is sent on push/pull,
	// MergeState receives peers' state and broadcasts.
	LocalState func() []byte
	MergeState func([]byte)
	// OnChange runs (off the gossip goroutines) after any membership or
	// ring change.
	OnChange func()
	// OnReturn runs when a member that was dead is alive again.
	OnReturn func(id string)
}

// Membership is the live member table.
type Membership struct {
	cfg Config

	mu        sync.Mutex
	ml        *memberlist.Memberlist
	running   bool
	started   time.Time
	stop      chan struct{}
	advHost   string
	members   map[string]*Member
	misses    map[string]int
	blocked   map[string]bool
	ringVer   uint64
	ringDig   string
	ringSet   []string
	metaDirty bool
	settled   bool // bootstrap chatter is suppressed until the view settles

	queue  *memberlist.TransmitLimitedQueue
	notify chan struct{}
	wg     sync.WaitGroup
}

// New returns a stopped membership for cfg.
func New(cfg Config) *Membership {
	if cfg.ReapAfter <= 0 {
		cfg.ReapAfter = 2 * time.Minute
	}
	m := &Membership{
		cfg:     cfg,
		members: map[string]*Member{},
		misses:  map[string]int{},
		blocked: map[string]bool{},
		notify:  make(chan struct{}, 1),
	}
	m.members[cfg.NodeID] = &Member{ID: cfg.NodeID, Self: true, Status: StatusStopped, InRing: true, Since: time.Now().UTC()}
	m.queue = &memberlist.TransmitLimitedQueue{NumNodes: m.numAlive, RetransmitMult: 3}
	return m
}

// Start creates the gossip layer and begins joining seeds. It may be called
// again after Stop; the node rejoins like a restarted process.
func (m *Membership) Start() error {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	host, portStr, err := net.SplitHostPort(m.cfg.Bind)
	if err != nil {
		return fmt.Errorf("membership: gossip bind %q: %w", m.cfg.Bind, err)
	}
	port, _ := strconv.Atoi(portStr)
	if host == "" {
		host = "0.0.0.0"
	}
	logger := log.New(m.logWriter(), "", log.LstdFlags)
	nt, err := memberlist.NewNetTransport(&memberlist.NetTransportConfig{BindAddrs: []string{host}, BindPort: port, Logger: logger})
	if err != nil {
		return fmt.Errorf("membership: listen %s: %w", m.cfg.Bind, err)
	}
	ft := newFilterTransport(nt, m.isBlocked)

	advIP := ""
	advHost := m.cfg.Advertise
	if advHost != "" {
		ips, err := net.LookupIP(advHost)
		if err != nil || len(ips) == 0 {
			_ = ft.Shutdown()
			return fmt.Errorf("membership: resolve advertise host %q: %v", advHost, err)
		}
		advIP = ips[0].String()
	}
	ip, advPort, err := ft.FinalAdvertiseAddr(advIP, nt.GetAutoBindPort())
	if err != nil {
		_ = ft.Shutdown()
		return fmt.Errorf("membership: advertise address: %w", err)
	}
	if advHost == "" {
		advHost = ip.String()
	}

	conf := memberlist.DefaultLANConfig()
	conf.Name = m.cfg.NodeID
	conf.Transport = ft
	conf.AdvertiseAddr = ip.String()
	conf.AdvertisePort = advPort
	conf.Delegate = &delegate{m: m}
	conf.Events = &eventDelegate{m: m}
	conf.Logger = logger
	conf.DeadNodeReclaimTime = time.Second
	conf.TCPTimeout = 2 * time.Second
	conf.ProbeInterval = time.Second
	conf.ProbeTimeout = 500 * time.Millisecond
	conf.SuspicionMult = 3
	conf.GossipInterval = 100 * time.Millisecond
	conf.PushPullInterval = 10 * time.Second
	if m.cfg.Fast {
		conf.ProbeInterval = 250 * time.Millisecond
		conf.ProbeTimeout = 100 * time.Millisecond
		conf.GossipInterval = 50 * time.Millisecond
		conf.PushPullInterval = 2 * time.Second
		conf.SuspicionMult = 2
	}

	m.mu.Lock()
	m.advHost = advHost
	self := m.members[m.cfg.NodeID]
	self.GossipAddr = net.JoinHostPort(ip.String(), strconv.Itoa(advPort))
	self.GRPCAddr = net.JoinHostPort(advHost, strconv.Itoa(m.cfg.GRPCPort))
	self.HTTPAddr = net.JoinHostPort(advHost, strconv.Itoa(m.cfg.HTTPPort))
	self.PublicURL = m.cfg.PublicURL
	self.Status = StatusAlive
	self.Since = time.Now().UTC()
	for id, mem := range m.members {
		if id != m.cfg.NodeID {
			mem.Status = StatusUnknown
			m.misses[id] = 0
		}
	}
	m.recomputeLocked()
	m.mu.Unlock()

	ml, err := memberlist.Create(conf)
	if err != nil {
		_ = ft.Shutdown()
		m.mu.Lock()
		self.Status = StatusStopped
		m.mu.Unlock()
		return fmt.Errorf("membership: create: %w", err)
	}

	m.mu.Lock()
	m.ml = ml
	m.running = true
	m.settled = false
	m.started = time.Now()
	m.stop = make(chan struct{})
	stop := m.stop
	m.mu.Unlock()

	m.wg.Add(4)
	go m.joinLoop(ml, stop)
	go m.probeLoop(ml, stop, conf.ProbeInterval)
	go m.reapLoop(stop)
	go m.notifyLoop(ml, stop)
	m.signal()
	return nil
}

// Stop shuts gossip down without a graceful leave, so peers have to detect
// the failure through missed probes, as they would for a crashed process.
func (m *Membership) Stop() {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	m.running = false
	ml := m.ml
	close(m.stop)
	self := m.members[m.cfg.NodeID]
	self.Status = StatusStopped
	self.Since = time.Now().UTC()
	m.mu.Unlock()

	_ = ml.Shutdown()
	m.wg.Wait()
}

// Running reports whether gossip is up.
func (m *Membership) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

// Self returns this node's member record.
func (m *Membership) Self() Member {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked(m.cfg.NodeID)
}

// Members returns every known member, sorted by id.
func (m *Membership) Members() []Member {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Member, 0, len(m.members))
	for id := range m.members {
		out = append(out, m.snapshotLocked(id))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Member returns one member record.
func (m *Membership) Member(id string) (Member, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.members[id]; !ok {
		return Member{}, false
	}
	return m.snapshotLocked(id), true
}

// Ring returns the current ring version, digest, and member set.
func (m *Membership) Ring() (uint64, string, []string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.ringVer, m.ringDig, append([]string(nil), m.ringSet...)
}

// Reachable reports whether peer RPCs to id are worth attempting: gossip is
// up here, the member is alive or merely suspect, and not partitioned away.
func (m *Membership) Reachable(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running {
		return false
	}
	if id == m.cfg.NodeID {
		return true
	}
	mem, ok := m.members[id]
	if !ok || m.blocked[id] {
		return false
	}
	return mem.Status == StatusAlive || mem.Status == StatusSuspect
}

// Block cuts gossip with peer (both directions, from this side).
func (m *Membership) Block(peer string) {
	m.mu.Lock()
	m.blocked[peer] = true
	m.mu.Unlock()
	m.signal()
}

// Unblock restores gossip with peer. An empty peer heals every partition.
func (m *Membership) Unblock(peer string) {
	m.mu.Lock()
	if peer == "" {
		m.blocked = map[string]bool{}
	} else {
		delete(m.blocked, peer)
	}
	m.mu.Unlock()
	m.signal()
}

// Blocked lists partitioned peers.
func (m *Membership) Blocked() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, 0, len(m.blocked))
	for id := range m.blocked {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Broadcast gossips msg to every member (used for cluster config).
func (m *Membership) Broadcast(msg []byte) {
	m.queue.QueueBroadcast(&broadcast{msg: msg})
}

func (m *Membership) snapshotLocked(id string) Member {
	mem := *m.members[id]
	mem.Partitioned = m.blocked[id]
	if mem.Self {
		mem.RingVersion = m.ringVer
		mem.RingDigest = m.ringDig
	}
	return mem
}

func (m *Membership) numAlive() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, mem := range m.members {
		if mem.Status == StatusAlive || mem.Status == StatusSuspect {
			n++
		}
	}
	return n
}

func (m *Membership) isBlocked(name, addr string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.blocked) == 0 {
		return false
	}
	if name != "" && m.blocked[name] {
		return true
	}
	if addr != "" {
		for id := range m.blocked {
			if mem, ok := m.members[id]; ok && mem.GossipAddr == addr {
				return true
			}
		}
	}
	return false
}

func (m *Membership) signal() {
	select {
	case m.notify <- struct{}{}:
	default:
	}
}

func (m *Membership) emit(kind events.Kind, level events.Level, format string, args ...any) {
	if m.cfg.Log != nil {
		m.cfg.Log.Emitf(kind, level, "", format, args...)
	}
}

// observe records a change in another member's state. subject and change
// let the dashboard fold the same observation from several nodes into one
// line ("node3 suspect, seen by node1, node2, node4").
func (m *Membership) observe(level events.Level, subject, change, format string, args ...any) {
	if m.cfg.Log != nil {
		m.cfg.Log.Emit(events.KindMembership, level, "", fmt.Sprintf(format, args...),
			map[string]string{"subject": subject, "change": change})
	}
}

// recomputeLocked rebuilds the ring member set and bumps the ring version
// when it changed. It returns whether placement changed.
func (m *Membership) recomputeLocked() bool {
	var set []string
	for id, mem := range m.members {
		if mem.InRing {
			set = append(set, id)
		}
	}
	sort.Strings(set)
	digest := ring.Digest(set)
	if digest == m.ringDig {
		return false
	}
	var peerMax uint64
	for id, mem := range m.members {
		if id != m.cfg.NodeID && mem.RingVersion > peerMax {
			peerMax = mem.RingVersion
		}
	}
	m.ringVer = max(m.ringVer, peerMax) + 1
	m.ringDig = digest
	m.ringSet = set
	m.metaDirty = true
	if m.settled {
		m.observe(events.LevelInfo, "ring", "ring", "ring v%d: %d members [%s]", m.ringVer, len(set), strings.Join(set, " "))
	}
	return true
}

func (m *Membership) onAlive(n *memberlist.Node, join bool) {
	meta := parseMeta(n.Meta)
	m.mu.Lock()
	if n.Name == m.cfg.NodeID {
		m.mu.Unlock()
		return
	}
	mem, known := m.members[n.Name]
	if !known {
		mem = &Member{ID: n.Name, Since: time.Now().UTC()}
		m.members[n.Name] = mem
	}
	prev := mem.Status
	mem.GossipAddr = n.Address()
	mem.GRPCAddr = meta.GRPC
	mem.HTTPAddr = meta.HTTP
	mem.PublicURL = meta.URL
	mem.RingVersion = meta.RingVersion
	mem.RingDigest = meta.RingDigest

	returned := false
	if join || prev == StatusUnknown || prev == "" {
		switch {
		case !known:
			if m.settled {
				m.observe(events.LevelOK, n.Name, "joined", "%s joined the cluster (gossip %s)", n.Name, mem.GossipAddr)
			}
		case prev == StatusDead:
			m.observe(events.LevelOK, n.Name, "alive", "%s is alive again", n.Name)
			returned = true
		case prev == StatusUnknown:
			returned = true
		}
		if prev != StatusSuspect || join {
			mem.Status = StatusAlive
			mem.Since = time.Now().UTC()
		}
		mem.InRing = true
		m.misses[n.Name] = 0
	}
	if mem.RingDigest == m.ringDig && mem.RingVersion > m.ringVer {
		m.ringVer = mem.RingVersion // same placement, newer label: adopt it
		m.metaDirty = true
	}
	m.recomputeLocked()
	m.mu.Unlock()

	if returned && m.cfg.OnReturn != nil {
		go m.cfg.OnReturn(n.Name)
	}
	m.signal()
}

func (m *Membership) onDead(n *memberlist.Node) {
	m.mu.Lock()
	if n.Name == m.cfg.NodeID {
		m.mu.Unlock()
		return
	}
	mem, ok := m.members[n.Name]
	if !ok {
		mem = &Member{ID: n.Name, InRing: true}
		m.members[n.Name] = mem
	}
	if mem.Status != StatusDead {
		mem.Status = StatusDead
		mem.Since = time.Now().UTC()
		m.observe(events.LevelErr, n.Name, "dead",
			"SWIM declared %s dead: no direct or indirect acks before the suspicion timeout", n.Name)
	}
	m.mu.Unlock()
	m.signal()
}

func (m *Membership) joinLoop(ml *memberlist.Memberlist, stop chan struct{}) {
	defer m.wg.Done()
	var seeds []string
	for _, s := range m.cfg.Seeds {
		if s != "" && s != m.cfg.Bind {
			seeds = append(seeds, s)
		}
	}
	if len(seeds) == 0 {
		return
	}
	for {
		n, err := ml.Join(seeds)
		if n > 0 {
			m.emit(events.KindMembership, events.LevelInfo, "%s joined gossip through %d seed(s)", m.cfg.NodeID, n)
			return
		}
		_ = err
		select {
		case <-stop:
			return
		case <-time.After(time.Second):
		}
	}
}

// probeLoop is the local suspicion signal: direct SWIM pings from this node.
func (m *Membership) probeLoop(ml *memberlist.Memberlist, stop chan struct{}, every time.Duration) {
	defer m.wg.Done()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		type target struct {
			id   string
			addr *net.UDPAddr
		}
		var targets []target
		m.mu.Lock()
		for id, mem := range m.members {
			if mem.Self || (mem.Status != StatusAlive && mem.Status != StatusSuspect) {
				continue
			}
			if addr, err := net.ResolveUDPAddr("udp", mem.GossipAddr); err == nil {
				targets = append(targets, target{id: id, addr: addr})
			}
		}
		m.mu.Unlock()

		var wg sync.WaitGroup
		results := make([]bool, len(targets))
		for i, tg := range targets {
			wg.Add(1)
			go func(i int, tg target) {
				defer wg.Done()
				_, err := ml.Ping(tg.id, tg.addr)
				results[i] = err == nil
			}(i, tg)
		}
		wg.Wait()

		changed := false
		m.mu.Lock()
		for i, tg := range targets {
			mem := m.members[tg.id]
			if mem == nil || mem.Status == StatusDead {
				continue
			}
			if results[i] {
				m.misses[tg.id] = 0
				if mem.Status == StatusSuspect {
					mem.Status = StatusAlive
					mem.Since = time.Now().UTC()
					changed = true
					m.observe(events.LevelOK, tg.id, "alive", "%s answers direct probes from %s again", tg.id, m.cfg.NodeID)
				}
				continue
			}
			m.misses[tg.id]++
			if m.misses[tg.id] >= 2 && mem.Status == StatusAlive {
				mem.Status = StatusSuspect
				mem.Since = time.Now().UTC()
				changed = true
				m.observe(events.LevelWarn, tg.id, "suspect",
					"%s missed %d direct probes from %s: suspect", tg.id, m.misses[tg.id], m.cfg.NodeID)
			}
		}
		m.mu.Unlock()
		if changed {
			m.signal()
		}
	}
}

// reapLoop removes long-dead members from the ring and settles members
// that were never heard from again after this node restarted.
func (m *Membership) reapLoop(stop chan struct{}) {
	defer m.wg.Done()
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		changed := false
		now := time.Now()
		m.mu.Lock()
		if !m.settled && now.Sub(m.started) > 5*time.Second {
			m.settled = true
			m.observe(events.LevelInfo, "ring", "ring", "%s settled on ring v%d with %d members [%s]",
				m.cfg.NodeID, m.ringVer, len(m.ringSet), strings.Join(m.ringSet, " "))
		}
		for id, mem := range m.members {
			switch {
			case mem.Status == StatusUnknown && now.Sub(m.started) > 10*time.Second:
				mem.Status = StatusDead
				mem.Since = now.UTC()
				changed = true
				m.observe(events.LevelWarn, id, "dead", "%s has not been heard from since %s rejoined; treating it as dead", id, m.cfg.NodeID)
			case mem.Status == StatusDead && mem.InRing && now.Sub(mem.Since) > m.cfg.ReapAfter:
				mem.InRing = false
				changed = true
				m.observe(events.LevelWarn, id, "reaped",
					"%s dead for over %s: removed from the ring; its keys will be re-replicated", id, m.cfg.ReapAfter)
			}
		}
		if changed {
			m.recomputeLocked()
		}
		m.mu.Unlock()
		if changed {
			m.signal()
		}
	}
}

// notifyLoop publishes metadata changes and runs OnChange outside gossip
// callbacks (memberlist holds its own locks while it calls delegates).
func (m *Membership) notifyLoop(ml *memberlist.Memberlist, stop chan struct{}) {
	defer m.wg.Done()
	for {
		select {
		case <-stop:
			return
		case <-m.notify:
		}
		m.mu.Lock()
		dirty := m.metaDirty
		m.metaDirty = false
		m.mu.Unlock()
		if dirty {
			_ = ml.UpdateNode(time.Second)
		}
		if m.cfg.OnChange != nil {
			m.cfg.OnChange()
		}
	}
}

func (m *Membership) logWriter() io.Writer {
	if m.cfg.Quiet {
		return io.Discard
	}
	return &levelFilter{out: log.Writer()}
}

// levelFilter keeps memberlist's warnings and errors and drops its debug
// chatter.
type levelFilter struct{ out io.Writer }

func (f *levelFilter) Write(p []byte) (int, error) {
	if strings.Contains(string(p), "[DEBUG]") {
		return len(p), nil
	}
	return f.out.Write(p)
}

func parseMeta(raw []byte) Meta {
	var meta Meta
	_ = json.Unmarshal(raw, &meta)
	return meta
}

type delegate struct{ m *Membership }

func (d *delegate) NodeMeta(limit int) []byte {
	d.m.mu.Lock()
	self := d.m.members[d.m.cfg.NodeID]
	meta := Meta{GRPC: self.GRPCAddr, HTTP: self.HTTPAddr, URL: self.PublicURL, RingVersion: d.m.ringVer, RingDigest: d.m.ringDig}
	d.m.mu.Unlock()
	raw, _ := json.Marshal(meta)
	if len(raw) > limit {
		meta.URL = ""
		raw, _ = json.Marshal(meta)
	}
	return raw
}

func (d *delegate) NotifyMsg(b []byte) {
	if len(b) == 0 || d.m.cfg.MergeState == nil {
		return
	}
	d.m.cfg.MergeState(append([]byte(nil), b...))
}

func (d *delegate) GetBroadcasts(overhead, limit int) [][]byte {
	return d.m.queue.GetBroadcasts(overhead, limit)
}

func (d *delegate) LocalState(bool) []byte {
	if d.m.cfg.LocalState == nil {
		return nil
	}
	return d.m.cfg.LocalState()
}

func (d *delegate) MergeRemoteState(buf []byte, _ bool) {
	if len(buf) == 0 || d.m.cfg.MergeState == nil {
		return
	}
	d.m.cfg.MergeState(append([]byte(nil), buf...))
}

type eventDelegate struct{ m *Membership }

func (e *eventDelegate) NotifyJoin(n *memberlist.Node)   { e.m.onAlive(n, true) }
func (e *eventDelegate) NotifyUpdate(n *memberlist.Node) { e.m.onAlive(n, false) }
func (e *eventDelegate) NotifyLeave(n *memberlist.Node)  { e.m.onDead(n) }

// broadcast is a cluster-config message. Only the newest one matters, so
// each new broadcast invalidates the queued ones.
type broadcast struct{ msg []byte }

func (b *broadcast) Invalidates(memberlist.Broadcast) bool { return true }
func (b *broadcast) Message() []byte                       { return b.msg }
func (b *broadcast) Finished()                             {}
