package replica

import (
	"context"

	"github.com/Arjun-Walia/Athanor/internal/store"
)

// Replica is one node's answer to "what do you hold for this key?".
type Replica struct {
	Node    string
	Found   bool
	Meta    store.ObjectMeta
	Body    []byte
	Corrupt bool // bytes on disk do not match the stored SHA-256
	Hinted  bool // the copy is a parked hint, not a primary replica
}

// Inventory is a node's full index, without payloads.
type Inventory struct {
	Node     string
	Objects  []store.ObjectMeta
	Hints    []store.ObjectMeta
	Tampered []string
	Bytes    uint64
}

// Peer is one cluster member as seen from a coordinator. The local node is
// a Peer too, so the coordinator never special-cases itself.
type Peer interface {
	ID() string
	Replicate(ctx context.Context, meta store.ObjectMeta, body []byte, reason string) (store.PutResult, error)
	GetReplica(ctx context.Context, key string, withBody bool) (Replica, error)
	Hint(ctx context.Context, target string, meta store.ObjectMeta, body []byte) error
	Inventory(ctx context.Context) (Inventory, error)
}

// View is the cluster as the local node currently sees it.
type View interface {
	Self() string
	Quorum() Quorum
	// Walk returns every ring member clockwise from key. The first N are the
	// preference list; the rest are sloppy-quorum fallbacks.
	Walk(key string) []string
	// Members is every ring member, sorted.
	Members() []string
	// Reachable is false for dead, stopped, or partitioned-away members.
	Reachable(node string) bool
	Peer(node string) Peer
}

// Preference is the first n entries of the walk.
func Preference(v View, key string, n int) (pref, fallbacks []string) {
	walk := v.Walk(key)
	if n > len(walk) {
		n = len(walk)
	}
	return walk[:n], walk[n:]
}
