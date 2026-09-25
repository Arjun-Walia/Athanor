// Package membership is the SWIM failure detector view.
//
// Phase B joins nodes with hashicorp/memberlist. A node moves from Alive to
// Suspect to Dead after missed probes. Stale ring versions are ignored.
package membership

// Status is the failure-detector state of one member.
type Status string

const (
	StatusAlive   Status = "alive"
	StatusSuspect Status = "suspect"
	StatusDead    Status = "dead"
)

// NodeState is the locally observed view of one cluster member.
type NodeState struct {
	ID          string
	Addr        string
	Status      Status
	VNodes      []uint64
	RingVersion uint64
}

// View is the membership this process currently trusts.
type View interface {
	Self() NodeState
	Members() []NodeState
	RingVersion() uint64
}
