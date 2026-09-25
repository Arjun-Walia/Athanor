package node

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/membership"
	"github.com/Arjun-Walia/Athanor/internal/replica"
)

// These tests run five real nodes in one process: real memberlist gossip over
// loopback UDP/TCP, real gRPC between them, real stores on temp dirs.

func freePort(t *testing.T) int {
	t.Helper()
	for i := 0; i < 20; i++ {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := l.Addr().(*net.TCPAddr).Port
		l.Close()
		u, err := net.ListenPacket("udp", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			continue
		}
		u.Close()
		return port
	}
	t.Fatal("no free port")
	return 0
}

type cluster struct {
	t     *testing.T
	nodes map[string]*Node
	names []string
}

func startCluster(t *testing.T, count int) *cluster {
	t.Helper()
	if testing.Short() {
		t.Skip("multi-node test")
	}
	c := &cluster{t: t, nodes: map[string]*Node{}}
	var seed string
	for i := 1; i <= count; i++ {
		id := fmt.Sprintf("node%d", i)
		gossip := "127.0.0.1:" + strconv.Itoa(freePort(t))
		if seed == "" {
			seed = gossip
		}
		n, err := New(Config{
			ID:            id,
			DataDir:       t.TempDir(),
			HTTPAddr:      "127.0.0.1:" + strconv.Itoa(freePort(t)),
			GRPCAddr:      "127.0.0.1:" + strconv.Itoa(freePort(t)),
			GossipAddr:    gossip,
			Seeds:         []string{seed},
			Quorum:        replica.DefaultQuorum(),
			VNodes:        16,
			ScrubInterval: time.Hour,
			ReapAfter:     time.Hour,
			RebalanceRate: 1000,
			RPCTimeout:    2 * time.Second,
			Fast:          true,
			Quiet:         true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = n.Close() })
		c.nodes[id] = n
		c.names = append(c.names, id)
	}
	c.eventually("every node sees every other alive", 15*time.Second, func() bool {
		for _, n := range c.nodes {
			if n.Ring().Size() != count {
				return false
			}
			for _, id := range c.names {
				if !n.Reachable(id) {
					return false
				}
			}
		}
		return true
	})
	return c
}

func (c *cluster) eventually(what string, timeout time.Duration, cond func() bool) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	c.t.Fatalf("timed out after %s waiting for: %s", timeout, what)
}

func (c *cluster) holds(node, key string, body []byte) bool {
	obj, err := c.nodes[node].Store().Get(key)
	return err == nil && !obj.Corrupt && bytes.Equal(obj.Body, body)
}

func TestClusterReplicatesAndReadsAnywhere(t *testing.T) {
	c := startCluster(t, 5)
	ctx := context.Background()
	body := []byte("%PDF-1.7 quarterly numbers")
	res, err := c.nodes["node1"].Coordinator().Put(ctx, "report.pdf", body, "application/pdf")
	if err != nil {
		t.Fatal(err)
	}
	c.eventually("all three preferred nodes hold report.pdf", 5*time.Second, func() bool {
		for _, p := range res.Preference {
			if !c.holds(p, "report.pdf", body) {
				return false
			}
		}
		return true
	})
	got, err := c.nodes["node3"].Coordinator().Get(ctx, "report.pdf")
	if err != nil || !bytes.Equal(got.Body, body) {
		t.Fatalf("get from node3 = %q, %v", got.Body, err)
	}
	ov, err := c.nodes["node4"].Overview(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(ov.Objects) != 1 || ov.Objects[0].Healthy != 3 || ov.Objects[0].UnderReplicated {
		t.Fatalf("replica map = %+v", ov.Objects)
	}
	if ov.Metrics.Overhead < 2.99 || ov.Metrics.Overhead > 3.01 {
		t.Fatalf("overhead = %v, want 3.0", ov.Metrics.Overhead)
	}
}

func TestClusterSurvivesStoppedNodeAndReplaysHint(t *testing.T) {
	c := startCluster(t, 5)
	ctx := context.Background()
	key := "while-you-were-out.txt"
	pref, _ := replica.Preference(c.nodes["node1"], key, 3)
	victim, coord := pref[1], pref[0]

	c.nodes[victim].Stop()
	c.eventually("SWIM declares the stopped node dead", 10*time.Second, func() bool {
		m, _ := c.nodes[coord].Membership().Member(victim)
		return m.Status == membership.StatusDead
	})

	body := []byte("written while a replica was down")
	res, err := c.nodes[coord].Coordinator().Put(ctx, key, body, "")
	if err != nil {
		t.Fatalf("write with one replica down: %v", err)
	}
	c.eventually("a hint is parked for the stopped node", 5*time.Second, func() bool {
		for _, n := range c.nodes {
			if n.ID() == victim {
				continue
			}
			hints, _ := n.Store().ListHints()
			for _, h := range hints {
				if h.Target == victim && h.Meta.Version == res.Meta.Version {
					return true
				}
			}
		}
		return false
	})
	got, err := c.nodes[pref[2]].Coordinator().Get(ctx, key)
	if err != nil || !bytes.Equal(got.Body, body) || !got.Degraded {
		t.Fatalf("degraded read = %q degraded=%v, %v", got.Body, got.Degraded, err)
	}

	if err := c.nodes[victim].Start(); err != nil {
		t.Fatal(err)
	}
	c.eventually("the hint is replayed to the returning node", 20*time.Second, func() bool {
		return c.holds(victim, key, body)
	})
	c.eventually("the hint queue drains", 10*time.Second, func() bool {
		for _, n := range c.nodes {
			if hints, _ := n.Store().ListHints(); len(hints) > 0 {
				return false
			}
		}
		return true
	})
}

func TestClusterHealsCorruptReplica(t *testing.T) {
	c := startCluster(t, 5)
	ctx := context.Background()
	body := []byte("bytes that must survive")
	res, err := c.nodes["node1"].Coordinator().Put(ctx, "k", body, "")
	if err != nil {
		t.Fatal(err)
	}
	c.eventually("replicated", 5*time.Second, func() bool {
		for _, p := range res.Preference {
			if !c.holds(p, "k", body) {
				return false
			}
		}
		return true
	})

	// Scrub path.
	victim := res.Preference[2]
	if err := c.nodes["node1"].Corrupt(ctx, "k", victim); err != nil {
		t.Fatal(err)
	}
	if c.holds(victim, "k", body) {
		t.Fatal("corrupt did not change the bytes")
	}
	if _, err := c.nodes["node2"].ScrubAll(ctx); err != nil {
		t.Fatal(err)
	}
	c.eventually("scrub heals the corrupt copy", 5*time.Second, func() bool { return c.holds(victim, "k", body) })

	// Read-repair path.
	victim = res.Preference[0]
	if err := c.nodes["node1"].Corrupt(ctx, "k", victim); err != nil {
		t.Fatal(err)
	}
	for _, reader := range c.names {
		got, err := c.nodes[reader].Coordinator().Get(ctx, "k")
		if err != nil || !bytes.Equal(got.Body, body) {
			t.Fatalf("read via %s returned %q, %v", reader, got.Body, err)
		}
	}
	c.eventually("read-repair heals the corrupt copy", 5*time.Second, func() bool { return c.holds(victim, "k", body) })
}

func TestClusterGossipsQuorumChange(t *testing.T) {
	c := startCluster(t, 5)
	if _, err := c.nodes["node2"].SetQuorum(replica.Quorum{N: 3, W: 3, R: 2}); err != nil {
		t.Fatal(err)
	}
	c.eventually("every node adopts W=3", 5*time.Second, func() bool {
		for _, n := range c.nodes {
			if n.Quorum().W != 3 {
				return false
			}
		}
		return true
	})
	if _, err := c.nodes["node2"].SetQuorum(replica.Quorum{N: 3, W: 4, R: 2}); err == nil {
		t.Fatal("W > N accepted")
	}
}

func TestClusterPartitionRoutesAround(t *testing.T) {
	c := startCluster(t, 5)
	ctx := context.Background()
	if err := c.nodes["node1"].Block("node2"); err != nil {
		t.Fatal(err)
	}
	if err := c.nodes["node2"].Block("node1"); err != nil {
		t.Fatal(err)
	}
	if c.nodes["node1"].Reachable("node2") {
		t.Fatal("node2 still reachable from node1 after partition")
	}
	// SWIM's indirect probes keep node2 alive for everyone else.
	time.Sleep(2 * time.Second)
	if m, _ := c.nodes["node3"].Membership().Member("node2"); m.Status == membership.StatusDead {
		t.Fatal("a partial partition should not get node2 declared dead")
	}
	for i := 0; i < 10; i++ {
		key := fmt.Sprintf("p-%d", i)
		if _, err := c.nodes["node1"].Coordinator().Put(ctx, key, []byte(key), ""); err != nil {
			t.Fatalf("write %s during partition: %v", key, err)
		}
		if got, err := c.nodes["node1"].Coordinator().Get(ctx, key); err != nil || string(got.Body) != key {
			t.Fatalf("read %s during partition: %q, %v", key, got.Body, err)
		}
	}
	c.nodes["node1"].Unblock("")
	c.nodes["node2"].Unblock("")
	c.eventually("node1 reaches node2 again", 5*time.Second, func() bool { return c.nodes["node1"].Reachable("node2") })
}

// A restart must not reset the cluster policy to the flags, and must not
// hand out a version older than one the node already issued.
func TestNodeRestartKeepsPolicyAndClock(t *testing.T) {
	dir := t.TempDir()
	mk := func() *Node {
		n, err := New(Config{
			ID: "node1", DataDir: dir,
			HTTPAddr: "127.0.0.1:" + strconv.Itoa(freePort(t)), GRPCAddr: "127.0.0.1:" + strconv.Itoa(freePort(t)),
			GossipAddr: "127.0.0.1:" + strconv.Itoa(freePort(t)),
			Quorum:     replica.Quorum{N: 1, W: 1, R: 1}, Fast: true, Quiet: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(); err != nil {
			t.Fatal(err)
		}
		return n
	}
	n := mk()
	if _, err := n.SetQuorum(replica.Quorum{N: 1, W: 1, R: 1}); err != nil {
		t.Fatal(err)
	}
	cfg := n.ClusterConfig()
	res, err := n.Coordinator().Put(context.Background(), "k", []byte("v"), "")
	if err != nil {
		t.Fatal(err)
	}
	// Push the clock far ahead, as a peer with a fast wall clock would.
	n.clock.Observe(res.Meta.Version + 1<<40)
	last := n.clock.Last()
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}

	n = mk()
	defer n.Close()
	if got := n.ClusterConfig(); got.Version != cfg.Version || got.Origin != cfg.Origin {
		t.Fatalf("policy after restart = %+v, want %+v", got, cfg)
	}
	if v := n.clock.Next(); v <= last {
		t.Fatalf("clock went backwards across restart: %d <= %d", v, last)
	}
	if ready, why := n.Ready(); !ready {
		t.Fatalf("single node not ready after restart: %s", why)
	}
	if h := n.Health(); h.Restarts != 1 || h.Events.Total == 0 {
		t.Fatalf("health = %+v", h)
	}
}

// Nodes that share a secret gossip and replicate normally; a node with a
// different secret can neither read the gossip nor call a peer.
func TestClusterSecretKeepsStrangersOut(t *testing.T) {
	if testing.Short() {
		t.Skip("multi-node test")
	}
	mk := func(id, secret, seed string) (*Node, string) {
		gossip := "127.0.0.1:" + strconv.Itoa(freePort(t))
		seeds := []string(nil)
		if seed != "" {
			seeds = []string{seed}
		}
		n, err := New(Config{
			ID: id, DataDir: t.TempDir(),
			HTTPAddr: "127.0.0.1:" + strconv.Itoa(freePort(t)), GRPCAddr: "127.0.0.1:" + strconv.Itoa(freePort(t)),
			GossipAddr: gossip, Seeds: seeds, Quorum: replica.Quorum{N: 2, W: 1, R: 1}, VNodes: 16,
			ScrubInterval: time.Hour, ReapAfter: time.Hour, RPCTimeout: 2 * time.Second,
			ClusterSecret: secret, Fast: true, Quiet: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = n.Close() })
		return n, gossip
	}
	a, seed := mk("node1", "hunter2", "")
	b, _ := mk("node2", "hunter2", seed)
	c := &cluster{t: t, nodes: map[string]*Node{"node1": a, "node2": b}, names: []string{"node1", "node2"}}
	c.eventually("the two nodes with the secret find each other", 15*time.Second, func() bool {
		return a.Reachable("node2") && b.Reachable("node1")
	})
	if !a.Secured() {
		t.Fatal("node should report itself secured")
	}
	body := []byte("only for those who know")
	if _, err := a.Coordinator().Put(context.Background(), "k", body, ""); err != nil {
		t.Fatalf("put across secured peers: %v", err)
	}
	c.eventually("replicated to both", 5*time.Second, func() bool { return c.holds("node1", "k", body) && c.holds("node2", "k", body) })

	stranger, _ := mk("node3", "different", seed)
	time.Sleep(2 * time.Second)
	if stranger.Reachable("node1") || a.Reachable("node3") {
		t.Fatal("a node with the wrong secret joined the ring")
	}
	if _, err := stranger.Coordinator().Get(context.Background(), "k"); err == nil {
		t.Fatal("the stranger read an object it should not see")
	}
}

// The overview the dashboard polls is served from a short-lived cache, so
// many pollers cost one fan-out.
func TestOverviewIsCachedBriefly(t *testing.T) {
	c := startCluster(t, 3)
	ctx := context.Background()
	first, err := c.nodes["node1"].Overview(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := c.nodes["node1"].Overview(ctx, false)
	if !first.GeneratedAt.Equal(second.GeneratedAt) {
		t.Fatal("two immediate overviews should share one computation")
	}
	time.Sleep(60 * time.Millisecond) // Fast mode: 20ms TTL
	third, _ := c.nodes["node1"].Overview(ctx, false)
	if third.GeneratedAt.Equal(first.GeneratedAt) {
		t.Fatal("the cache should have expired")
	}
}
