package replica

import (
	"sync"
	"time"
)

// Clock issues per-object versions. It is a hybrid logical clock: the high
// bits are wall-clock milliseconds and the low 16 bits a counter, and it
// never goes backwards, even if the wall clock does or a peer's version is
// ahead. Ties between nodes are broken by origin id (see store.Newer).
type Clock struct {
	mu   sync.Mutex
	last uint64
}

// Next returns a version greater than every version issued or observed.
func (c *Clock) Next() uint64 {
	now := uint64(time.Now().UnixMilli()) << 16
	c.mu.Lock()
	defer c.mu.Unlock()
	if now > c.last {
		c.last = now
	} else {
		c.last++
	}
	return c.last
}

// Observe advances the clock past a version seen from a peer, or read back
// from the local index when the process restarts.
func (c *Clock) Observe(v uint64) {
	c.mu.Lock()
	if v > c.last {
		c.last = v
	}
	c.mu.Unlock()
}

// Last is the highest version issued or observed so far. The node stores it
// so a restart can never hand out a version older than one it already gave.
func (c *Clock) Last() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}

// VersionTime recovers the wall-clock part of a version.
func VersionTime(v uint64) time.Time {
	return time.UnixMilli(int64(v >> 16)).UTC()
}
