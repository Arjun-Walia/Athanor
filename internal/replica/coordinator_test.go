package replica_test

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/replica/replicatest"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

var names = []string{"node1", "node2", "node3", "node4", "node5"}

func coordinator(c *replicatest.Cluster, self string) *replica.Coordinator {
	return replica.NewCoordinator(c.View(self), &replica.Clock{}, events.New(self, 100, true), time.Second)
}

func holders(t *testing.T, c *replicatest.Cluster, key string) []string {
	t.Helper()
	var out []string
	for _, n := range names {
		if _, err := c.Stores[n].Head(key); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func TestPutPlacesNReplicasOnThePreferenceList(t *testing.T) {
	c := replicatest.New(t, names)
	co := coordinator(c, "node1")
	res, err := co.Put(context.Background(), "report.pdf", []byte("pdf bytes"), "application/pdf")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Acks) < 2 {
		t.Fatalf("acks = %+v", res.Acks)
	}
	// Remaining replicas finish in the background.
	deadline := time.Now().Add(2 * time.Second)
	for len(holders(t, c, "report.pdf")) < 3 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	got := holders(t, c, "report.pdf")
	pref, _ := replica.Preference(c.View("node1"), "report.pdf", 3)
	if len(got) != 3 {
		t.Fatalf("holders = %v, want preference %v", got, pref)
	}
	for _, p := range pref {
		if _, err := c.Stores[p].Head("report.pdf"); err != nil {
			t.Fatalf("preferred node %s has no copy", p)
		}
	}
}

func TestGetFromAnotherCoordinator(t *testing.T) {
	c := replicatest.New(t, names)
	if _, err := coordinator(c, "node1").Put(context.Background(), "k", []byte("hello"), ""); err != nil {
		t.Fatal(err)
	}
	res, err := coordinator(c, "node3").Get(context.Background(), "k")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(res.Body, []byte("hello")) {
		t.Fatalf("body = %q", res.Body)
	}
}

func TestSloppyQuorumParksHintAndReadStillWorks(t *testing.T) {
	c := replicatest.New(t, names)
	pref, fallbacks := replica.Preference(c.View("node1"), "k", 3)
	dead := pref[1]
	c.SetDown(dead, true)

	co := coordinator(c, pref[0])
	res, err := co.Put(context.Background(), "k", []byte("v1"), "")
	if err != nil {
		t.Fatalf("write with one preferred node down: %v", err)
	}
	_ = res
	time.Sleep(50 * time.Millisecond)
	hints, _ := c.Stores[fallbacks[0]].ListHints()
	if len(hints) != 1 || hints[0].Target != dead {
		t.Fatalf("hint on %s = %+v, want one for %s", fallbacks[0], hints, dead)
	}
	got, err := coordinator(c, pref[2]).Get(context.Background(), "k")
	if err != nil || string(got.Body) != "v1" {
		t.Fatalf("degraded get = %q, %v", got.Body, err)
	}
	if !got.Degraded {
		t.Fatal("read with a dead preferred node should report degraded")
	}
}

func TestWriteFailsWithoutQuorum(t *testing.T) {
	c := replicatest.New(t, []string{"node1", "node2", "node3"})
	c.SetDown("node2", true)
	c.SetDown("node3", true)
	c.Quorum = replica.Quorum{N: 3, W: 2, R: 2}
	_, err := coordinator(c, "node1").Put(context.Background(), "k", []byte("x"), "")
	var qe *replica.QuorumError
	if !errors.As(err, &qe) || qe.Got != 1 || qe.Need != 2 {
		t.Fatalf("err = %v", err)
	}
}

func TestReadSkipsCorruptReplicaAndReportsDivergence(t *testing.T) {
	c := replicatest.New(t, names)
	co := coordinator(c, "node1")
	if _, err := co.Put(context.Background(), "k", []byte("good bytes"), ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	pref, _ := replica.Preference(c.View("node1"), "k", 3)
	if err := c.Stores[pref[0]].Corrupt("k"); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var why []string
	done := make(chan struct{}, 1)
	reader := coordinator(c, "node2")
	reader.OnDivergence = func(key, reason string) {
		mu.Lock()
		why = append(why, reason)
		mu.Unlock()
		done <- struct{}{}
	}
	res, err := reader.Get(context.Background(), "k")
	if err != nil || string(res.Body) != "good bytes" {
		t.Fatalf("get = %q, %v", res.Body, err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("no divergence reported for a corrupt replica")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(why) == 0 {
		t.Fatal("empty divergence")
	}
}

func TestDeleteWritesTombstone(t *testing.T) {
	c := replicatest.New(t, names)
	co := coordinator(c, "node1")
	if _, err := co.Put(context.Background(), "k", []byte("x"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := co.Delete(context.Background(), "k"); err != nil {
		t.Fatal(err)
	}
	_, err := co.Get(context.Background(), "k")
	if !errors.Is(err, replica.ErrNotFound) {
		t.Fatalf("get after delete = %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	for _, n := range holders(t, c, "k") {
		m, _ := c.Stores[n].Head("k")
		if !m.Deleted {
			t.Fatalf("%s still has a live copy", n)
		}
	}
}

func TestClockIsMonotonic(t *testing.T) {
	var clk replica.Clock
	prev := clk.Next()
	clk.Observe(prev + 1000)
	for i := 0; i < 1000; i++ {
		v := clk.Next()
		if v <= prev {
			t.Fatalf("clock went backwards: %d after %d", v, prev)
		}
		prev = v
	}
}

// flakyView fails the first Replicate and the first GetReplica on every
// peer, then behaves. It models a connection that was half-open when a
// peer restarted: the first call errors, the redial succeeds.
type flakyView struct {
	replica.View
	mu     sync.Mutex
	failed map[string]bool
}

type flakyPeer struct {
	replica.Peer
	v *flakyView
}

var errFlaky = errors.New("transient")

func (v *flakyView) Peer(node string) replica.Peer {
	return &flakyPeer{Peer: v.View.Peer(node), v: v}
}

// trip reports whether this is the first call of op on this peer.
func (p *flakyPeer) trip(op string) bool {
	p.v.mu.Lock()
	defer p.v.mu.Unlock()
	k := p.ID() + ":" + op
	if p.v.failed[k] {
		return false
	}
	p.v.failed[k] = true
	return true
}

func (p *flakyPeer) Replicate(ctx context.Context, m store.ObjectMeta, b []byte, r string) (store.PutResult, error) {
	if p.trip("replicate") {
		return store.PutResult{}, errFlaky
	}
	return p.Peer.Replicate(ctx, m, b, r)
}

func (p *flakyPeer) GetReplica(ctx context.Context, key string, withBody bool) (replica.Replica, error) {
	if p.trip("get") {
		return replica.Replica{}, errFlaky
	}
	return p.Peer.GetReplica(ctx, key, withBody)
}

func TestWriteRetriesATransientReplicaFailure(t *testing.T) {
	c := replicatest.New(t, names)
	fv := &flakyView{View: c.View("node1"), failed: map[string]bool{}}
	co := replica.NewCoordinator(fv, &replica.Clock{}, events.New("node1", 100, true), time.Second)
	co.Retry = 20 * time.Millisecond
	res, err := co.Put(context.Background(), "k", []byte("once more"), "")
	if err != nil {
		t.Fatalf("write with a transient failure on every replica: %v", err)
	}
	for _, a := range res.Acks {
		if a.HintFor != "" {
			t.Fatalf("a retried write should not fall back to a hint: %+v", res.Acks)
		}
	}
	got, err := co.Get(context.Background(), "k")
	if err != nil || string(got.Body) != "once more" {
		t.Fatalf("read back = %q, %v", got.Body, err)
	}
	if got.Degraded {
		t.Fatal("a read that succeeded on retry should not be degraded")
	}
}
