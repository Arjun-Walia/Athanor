// Package replica coordinates quorum reads and writes.
//
// The node that accepts a client call is a stateless coordinator. It builds
// a preference list from the local ring and replicates over gRPC. When a
// preferred node is unreachable the write goes to the next healthy node on
// the ring as a hint (sloppy quorum). Reads query the preference list, pick
// the newest replica whose bytes verify, and report any divergence so the
// single Repair path can heal it.
package replica

import "fmt"

// Quorum is the cluster durability policy.
// Default is N=3, W=2, R=2. Per-bucket overrides are out of scope for the MVP.
type Quorum struct {
	N int `json:"n"`
	W int `json:"w"`
	R int `json:"r"`
}

// MaxN bounds the replication factor the control plane accepts.
const MaxN = 7

// DefaultQuorum is the MVP policy. Three replicas, acknowledge after two,
// read two. Storage overhead is stated as 3x; erasure coding is not built.
func DefaultQuorum() Quorum {
	return Quorum{N: 3, W: 2, R: 2}
}

// Valid reports whether the triple can be used as a write and read policy.
// It does not require W+R > N. A caller may choose a weaker pair on purpose.
func (q Quorum) Valid() bool {
	return q.N > 0 && q.W > 0 && q.R > 0 && q.W <= q.N && q.R <= q.N
}

// Validate is Valid with a reason, for API errors.
func (q Quorum) Validate() error {
	switch {
	case q.N < 1 || q.N > MaxN:
		return fmt.Errorf("n must be between 1 and %d", MaxN)
	case q.W < 1 || q.W > q.N:
		return fmt.Errorf("w must be between 1 and n (%d)", q.N)
	case q.R < 1 || q.R > q.N:
		return fmt.Errorf("r must be between 1 and n (%d)", q.N)
	}
	return nil
}

// Overlapping reports whether every read quorum intersects every write
// quorum (W + R > N), which is what makes a read see the latest ack'd write
// when no node has failed.
func (q Quorum) Overlapping() bool { return q.W+q.R > q.N }

// WriteTolerance is how many owners can be down while a write still reaches
// W without a hint; ReadTolerance is the same for reads and R.
func (q Quorum) WriteTolerance() int { return q.N - q.W }

// ReadTolerance is how many owners can be down while a read still reaches R.
func (q Quorum) ReadTolerance() int { return q.N - q.R }

func (q Quorum) String() string { return fmt.Sprintf("%d/%d/%d", q.N, q.W, q.R) }
