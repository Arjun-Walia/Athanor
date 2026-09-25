// Package ring places objects with a consistent-hash ring.
//
// Every node owns a fixed number of virtual nodes. A key hashes to a point
// on the ring and walks clockwise to N distinct physical nodes. Membership
// and the ring version are gossiped; each node computes ownership locally.
// There is no central object index and no Raft metadata cluster.
package ring

// DefaultVNodes is the vnode count per physical node.
// Bounded so join and leave work stays predictable.
const DefaultVNodes = 64

// PreferenceList is the ordered owner list for one key.
type PreferenceList struct {
	Key   string
	Nodes []string
}

// Ring is the locally computed placement view at one ring version.
type Ring interface {
	Version() uint64
	Preference(key string, n int) (PreferenceList, error)
}
