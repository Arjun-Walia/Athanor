// Package replica coordinates quorum reads and writes.
//
// The node that accepts a client call is a stateless coordinator. It builds
// a preference list from the local ring and replicates over gRPC. Sloppy
// quorum, hinted handoff, and read-repair are later phases; this package
// currently holds the durability policy those phases will share.
package replica

// Quorum is the cluster durability policy.
// Default is N=3, W=2, R=2. Per-bucket overrides are out of scope for the MVP.
type Quorum struct {
	N int
	W int
	R int
}

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
