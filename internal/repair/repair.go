// Package repair is the only repair implementation in the node.
//
// Read-repair, the scrubber, and hinted-handoff replay all call Repair.
// Rebalance is a separate rate-limited copy, not a second healing algorithm.
package repair

// Reason identifies which caller asked for repair. The dashboard event log
// prints these strings.
type Reason string

const (
	ReasonReadRepair Reason = "read-repair"
	ReasonScrub      Reason = "scrub"
	ReasonHintReplay Reason = "hint-replay"
	ReasonRebalance  Reason = "rebalance"
)

// Report is one repair outcome.
type Report struct {
	Key     string
	Winner  uint64
	Pushed  []string
	Dropped []string
	Reason  Reason
}

// Repairer heals one key across the preference list and any hint holders.
// The winner is the highest version whose payload matches its checksum.
type Repairer interface {
	Repair(key string) (Report, error)
}

// Scrubber walks the local index, recomputes checksums, and calls Repair
// on mismatch.
type Scrubber interface {
	ScrubOnce() error
}

// Rebalancer copies keys onto or off this node after a ring-version change.
// Copies are rate-limited.
type Rebalancer interface {
	Rebalance() error
}
