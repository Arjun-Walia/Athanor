// Package replicatest is an in-process cluster for coordinator and repair
// tests: real stores on temp dirs, a real ring, and switchable reachability.
// There is no network in it, so a test can turn a node off and on in one
// line and never waits for a failure detector.
package replicatest

import (
	"context"
	"errors"
	"sort"
	"sync"
	"testing"

	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/ring"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// Cluster is a set of in-process nodes sharing one ring.
type Cluster struct {
	Ring   *ring.Ring
	Stores map[string]*store.Disk
	Quorum replica.Quorum

	mu   sync.Mutex
	down map[string]bool
}

// New opens n stores named node1..nodeN.
func New(t *testing.T, names []string) *Cluster {
	t.Helper()
	c := &Cluster{
		Ring:   ring.New(names, 16, 1),
		Stores: map[string]*store.Disk{},
		Quorum: replica.DefaultQuorum(),
		down:   map[string]bool{},
	}
	for _, n := range names {
		d, err := store.Open(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Close() })
		c.Stores[n] = d
	}
	return c
}

// SetDown marks a node unreachable (or back up).
func (c *Cluster) SetDown(node string, down bool) {
	c.mu.Lock()
	c.down[node] = down
	c.mu.Unlock()
}

// Down lists the nodes currently marked unreachable, sorted.
func (c *Cluster) Down() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for n, d := range c.down {
		if d {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func (c *Cluster) isDown(node string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.down[node]
}

// View returns the cluster as seen from self.
func (c *Cluster) View(self string) replica.View { return &view{c: c, self: self} }

type view struct {
	c    *Cluster
	self string
}

func (v *view) Self() string             { return v.self }
func (v *view) Quorum() replica.Quorum   { return v.c.Quorum }
func (v *view) Walk(key string) []string { return v.c.Ring.Walk(key) }
func (v *view) Members() []string        { return v.c.Ring.Nodes() }
func (v *view) Reachable(node string) bool {
	return !v.c.isDown(node) && v.c.Stores[node] != nil
}
func (v *view) Peer(node string) replica.Peer {
	return &peer{c: v.c, inner: &replica.LocalPeer{Node: node, Store: v.c.Stores[node]}}
}

// peer fails every call while its node is down, like a dead process would.
type peer struct {
	c     *Cluster
	inner *replica.LocalPeer
}

var errDown = errors.New("replicatest: node down")

func (p *peer) ID() string { return p.inner.Node }
func (p *peer) Replicate(ctx context.Context, m store.ObjectMeta, b []byte, r string) (store.PutResult, error) {
	if p.c.isDown(p.inner.Node) {
		return store.PutResult{}, errDown
	}
	return p.inner.Replicate(ctx, m, b, r)
}
func (p *peer) GetReplica(ctx context.Context, key string, withBody bool) (replica.Replica, error) {
	if p.c.isDown(p.inner.Node) {
		return replica.Replica{}, errDown
	}
	return p.inner.GetReplica(ctx, key, withBody)
}
func (p *peer) Hint(ctx context.Context, target string, m store.ObjectMeta, b []byte) error {
	if p.c.isDown(p.inner.Node) {
		return errDown
	}
	return p.inner.Hint(ctx, target, m, b)
}
func (p *peer) Inventory(ctx context.Context) (replica.Inventory, error) {
	if p.c.isDown(p.inner.Node) {
		return replica.Inventory{}, errDown
	}
	return p.inner.Inventory(ctx)
}
