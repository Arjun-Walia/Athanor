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

// Observe advances the clock past a version seen from a peer.
func (c *Clock) Observe(v uint64) {
	c.mu.Lock()
	if v > c.last {
		c.last = v
	}
	c.mu.Unlock()
}

// VersionTime recovers the wall-clock part of a version.
func VersionTime(v uint64) time.Time {
	return time.UnixMilli(int64(v >> 16)).UTC()
}
