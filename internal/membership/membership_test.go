package membership

import (
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
)

func freeAddr(t *testing.T) string {
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
		return "127.0.0.1:" + strconv.Itoa(port)
	}
	t.Fatal("no free port")
	return ""
}

func start(t *testing.T, id, bind string, seeds ...string) *Membership {
	t.Helper()
	m := New(Config{
		NodeID: id, Bind: bind, GRPCPort: 1, HTTPPort: 2, Seeds: seeds,
		ReapAfter: time.Hour, Fast: true, Quiet: true, Log: events.New(id, 100, true),
	})
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	return m
}

func eventually(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

// After a full cut (every peer declared dead) a node keeps knocking on its
// seeds, so the cluster reforms without anyone restarting the survivor.
func TestRejoinsSeedsAfterEveryPeerDied(t *testing.T) {
	if testing.Short() {
		t.Skip("gossip test")
	}
	seedAddr := freeAddr(t)
	a := start(t, "node1", seedAddr)
	b := start(t, "node2", freeAddr(t), seedAddr)
	eventually(t, "node2 sees node1 alive", 5*time.Second, func() bool { return b.Reachable("node1") })
	if b.Isolated() {
		t.Fatal("node2 isolated with node1 alive")
	}

	a.Stop()
	eventually(t, "node2 declares node1 dead", 10*time.Second, func() bool {
		m, _ := b.Member("node1")
		return m.Status == StatusDead
	})
	if !b.Isolated() {
		t.Fatal("node2 should be isolated once its only peer is dead")
	}

	// node1 comes back on the same address, as a restarted process would.
	// It has no seed of its own (it *is* the seed), so only node2's rejoin
	// loop can bring the two back together.
	if err := a.Start(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "node2 rejoins node1 through its seed", 15*time.Second, func() bool {
		return b.Reachable("node1") && a.Reachable("node2")
	})
	if b.Isolated() {
		t.Fatal("still isolated after the rejoin")
	}
	_, _, set := b.Ring()
	if len(set) != 2 {
		t.Fatalf("ring after rejoin = %v", set)
	}
}

func TestBlockedPeerIsUnreachableAndListed(t *testing.T) {
	m := New(Config{NodeID: "node1", Bind: freeAddr(t), GRPCPort: 1, HTTPPort: 2, Fast: true, Quiet: true})
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Stop)
	if !m.Reachable("node1") {
		t.Fatal("a node must always reach itself")
	}
	m.Block("node3")
	if got := m.Blocked(); len(got) != 1 || got[0] != "node3" {
		t.Fatalf("blocked = %v", got)
	}
	if m.Reachable("node3") {
		t.Fatal("blocked peer reachable")
	}
	m.Unblock("")
	if len(m.Blocked()) != 0 {
		t.Fatal("unblock all left partitions behind")
	}
}
