package repair

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// Timeouts for the background jobs' peer calls. A peer inventory is a list
// of metadata; a copy carries a whole object and gets longer.
const (
	inventoryTimeout = 3 * time.Second
	copyTimeout      = 5 * time.Second
)

// RepairFunc is the single repair entry point the background jobs call.
type RepairFunc func(ctx context.Context, key string, reason Reason) (Report, error)

// ScrubStatus is shown on the dashboard's scrub dial.
type ScrubStatus struct {
	Interval     time.Duration `json:"-"`
	Every        float64       `json:"every_seconds"`
	LastAt       time.Time     `json:"last_at"`
	NextAt       time.Time     `json:"next_at"`
	Checked      int           `json:"checked"`
	Mismatches   int           `json:"mismatches"`
	HintsChecked int           `json:"hints_checked"`
	HintsDropped int           `json:"hints_dropped"`
	Passes       uint64        `json:"passes"`
	Running      bool          `json:"running"`
}

// ScrubResult is one pass: primary replicas and parked hints.
type ScrubResult struct {
	Checked      int
	Mismatches   int
	HintsChecked int
	HintsDropped int
}

// Scrubber walks the local index, recomputes every checksum, and calls
// Repair on mismatch.
type Scrubber struct {
	store    *store.Disk
	repair   RepairFunc
	log      *events.Log
	interval time.Duration

	mu     sync.Mutex
	status ScrubStatus
	run    sync.Mutex
}

// NewScrubber returns a scrubber that runs every interval.
func NewScrubber(s *store.Disk, repair RepairFunc, log *events.Log, interval time.Duration) *Scrubber {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Scrubber{store: s, repair: repair, log: log, interval: interval,
		status: ScrubStatus{Interval: interval, Every: interval.Seconds()}}
}

// Status returns the last pass and the next scheduled one.
func (s *Scrubber) Status() ScrubStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Run scrubs on a timer until ctx ends.
func (s *Scrubber) Run(ctx context.Context) {
	t := time.NewTicker(s.interval)
	defer t.Stop()
	s.mu.Lock()
	s.status.NextAt = time.Now().Add(s.interval).UTC()
	s.mu.Unlock()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_, _, _ = s.ScrubOnce(ctx, false)
		}
	}
}

// ScrubOnce checks every local replica once. manual passes always log a
// summary; timed passes log only when they find something.
func (s *Scrubber) ScrubOnce(ctx context.Context, manual bool) (checked, mismatches int, err error) {
	res, err := s.ScrubPass(ctx, manual)
	return res.Checked, res.Mismatches, err
}

// ScrubPass is ScrubOnce with the hint numbers too. Primary replicas that
// fail their checksum are repaired from the other owners; parked hints that
// fail theirs are dropped, since a hint is only a courtesy copy and the
// owner will be rebuilt by Repair.
func (s *Scrubber) ScrubPass(ctx context.Context, manual bool) (res ScrubResult, err error) {
	s.run.Lock()
	defer s.run.Unlock()
	s.mu.Lock()
	s.status.Running = true
	s.mu.Unlock()
	defer func() {
		now := time.Now().UTC()
		s.mu.Lock()
		s.status.Running = false
		s.status.LastAt = now
		s.status.NextAt = now.Add(s.interval)
		s.status.Checked = res.Checked
		s.status.Mismatches = res.Mismatches
		s.status.HintsChecked = res.HintsChecked
		s.status.HintsDropped = res.HintsDropped
		s.status.Passes++
		s.mu.Unlock()
	}()

	metas, err := s.store.List()
	if err != nil {
		return res, err
	}
	for _, m := range metas {
		if ctx.Err() != nil {
			return res, ctx.Err()
		}
		if m.Deleted {
			continue
		}
		ok, verr := s.store.Verify(m.Key)
		if errors.Is(verr, store.ErrNotFound) {
			continue
		}
		res.Checked++
		if ok {
			continue
		}
		res.Mismatches++
		s.log.Emit(events.KindScrub, events.LevelWarn, m.Key,
			fmt.Sprintf("scrub: checksum mismatch for %s on %s", m.Key, s.log.Node()), nil)
		if _, rerr := s.repair(ctx, m.Key, ReasonScrub); rerr != nil {
			s.log.Emitf(events.KindScrub, events.LevelErr, m.Key, "scrub: repair of %s failed: %v", m.Key, rerr)
		}
	}
	if hc, hd, herr := s.store.VerifyHints(); herr == nil {
		res.HintsChecked, res.HintsDropped = hc, hd
		if hd > 0 {
			s.log.Emit(events.KindScrub, events.LevelWarn, "",
				fmt.Sprintf("scrub: dropped %d corrupt parked hint(s) on %s; owners will be repaired from the other replicas", hd, s.log.Node()), nil)
		}
	}
	if (manual && res.Checked > 0) || res.Mismatches > 0 {
		level := events.LevelOK
		if res.Mismatches > 0 {
			level = events.LevelWarn
		}
		s.log.Emit(events.KindScrub, level, "",
			fmt.Sprintf("scrub pass on %s: %d replicas verified, %d mismatches", s.log.Node(), res.Checked, res.Mismatches), nil)
	}
	return res, nil
}

// HintReplayer hands parked writes back to their owners once they return.
// Delivery goes through Repair, so a replayed hint is healed exactly like a
// read-repair or a scrub finding.
type HintReplayer struct {
	store  *store.Disk
	view   replica.View
	repair RepairFunc
	log    *events.Log
	kick   chan struct{}
	run    sync.Mutex
}

// NewHintReplayer returns a replayer for the local hint queue.
func NewHintReplayer(s *store.Disk, view replica.View, repair RepairFunc, log *events.Log) *HintReplayer {
	return &HintReplayer{store: s, view: view, repair: repair, log: log, kick: make(chan struct{}, 1)}
}

// Kick asks for a replay pass soon, e.g. when a member comes back.
func (h *HintReplayer) Kick() {
	select {
	case h.kick <- struct{}{}:
	default:
	}
}

// Run replays on a short timer and whenever kicked.
func (h *HintReplayer) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-h.kick:
		}
		h.ReplayOnce(ctx)
	}
}

// ReplayOnce tries every parked hint whose target is reachable again.
func (h *HintReplayer) ReplayOnce(ctx context.Context) int {
	h.run.Lock()
	defer h.run.Unlock()
	hints, err := h.store.ListHints()
	if err != nil || len(hints) == 0 {
		return 0
	}
	delivered := 0
	for _, hint := range hints {
		if ctx.Err() != nil {
			return delivered
		}
		key, target := hint.Meta.Key, hint.Target
		pref, _ := replica.Preference(h.view, key, h.view.Quorum().N)
		owner := slices.Contains(pref, target)
		if owner && !h.view.Reachable(target) {
			continue
		}
		if _, err := h.repair(ctx, key, ReasonHintReplay); err != nil {
			continue
		}
		if owner {
			rctx, cancel := context.WithTimeout(ctx, inventoryTimeout)
			rep, err := h.view.Peer(target).GetReplica(rctx, key, false)
			cancel()
			if err != nil || !rep.Found || rep.Hinted || rep.Corrupt || !store.AtLeast(rep.Meta, hint.Meta) {
				continue
			}
		}
		if err := h.store.DeleteHintIf(target, hint.Meta); err != nil {
			continue
		}
		delivered++
		if owner {
			h.log.Emit(events.KindHint, events.LevelOK, key,
				fmt.Sprintf("hint replay: %s delivered to %s (parked on %s)", key, target, h.log.Node()),
				map[string]string{"target": target})
		} else {
			h.log.Emit(events.KindHint, events.LevelInfo, key,
				fmt.Sprintf("hint for %s on %s retired: %s no longer owns it; current owners repaired", key, h.log.Node(), target),
				map[string]string{"target": target})
		}
	}
	return delivered
}

// Rebalancer runs the "keys I should hold" pass. For every local replica it
// makes sure each reachable owner in the current preference list holds the
// same or a newer version, copying at a bounded rate; a node that is no
// longer an owner drops its copy only once every owner is confirmed.
type Rebalancer struct {
	store   *store.Disk
	view    replica.View
	log     *events.Log
	limiter *TokenBucket

	run  sync.Mutex
	kick chan string

	mu   sync.Mutex
	last RebalanceSummary
}

// RebalanceSummary is the outcome of one pass.
type RebalanceSummary struct {
	At      time.Time `json:"at"`
	Why     string    `json:"why"`
	Checked int       `json:"checked"`
	Copied  int       `json:"copied"`
	Dropped int       `json:"dropped"`
}

// NewRebalancer returns a rebalancer limited to objectsPerSec copies.
func NewRebalancer(s *store.Disk, view replica.View, log *events.Log, objectsPerSec float64) *Rebalancer {
	if objectsPerSec <= 0 {
		objectsPerSec = 20
	}
	return &Rebalancer{store: s, view: view, log: log,
		limiter: NewTokenBucket(objectsPerSec, int(objectsPerSec)), kick: make(chan string, 1)}
}

// Kick schedules a pass, e.g. after the ring version changes.
func (b *Rebalancer) Kick(why string) {
	select {
	case b.kick <- why:
	default:
	}
}

// Last returns the most recent pass summary.
func (b *Rebalancer) Last() RebalanceSummary {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.last
}

// Run waits settle after a kick (so a burst of membership changes causes
// one pass) and also sweeps every period as anti-entropy.
func (b *Rebalancer) Run(ctx context.Context, settle, period time.Duration) {
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		why := "periodic anti-entropy"
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case why = <-b.kick:
			timer := time.NewTimer(settle)
		drain:
			for {
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case w := <-b.kick:
					why = w
				case <-timer.C:
					break drain
				}
			}
		}
		b.RunOnce(ctx, why)
	}
}

// RunOnce performs one pass.
func (b *Rebalancer) RunOnce(ctx context.Context, why string) RebalanceSummary {
	b.run.Lock()
	defer b.run.Unlock()
	sum := RebalanceSummary{At: time.Now().UTC(), Why: why}
	defer func() {
		b.mu.Lock()
		b.last = sum
		b.mu.Unlock()
	}()

	local, err := b.store.List()
	if err != nil || len(local) == 0 {
		return sum
	}
	inventories := b.peerInventories(ctx)
	emit := b.boundedEmitter(maxRebalanceLines)
	for _, meta := range local {
		if ctx.Err() != nil {
			break
		}
		sum.Checked++
		copied, dropped, stopped := b.rebalanceKey(ctx, meta, inventories, emit)
		sum.Copied += copied
		sum.Dropped += dropped
		if stopped {
			return sum
		}
	}
	if sum.Copied > 0 || sum.Dropped > 0 {
		b.log.Emit(events.KindRebalance, events.LevelOK, "",
			fmt.Sprintf("rebalance on %s (%s): %d checked, %d copied, %d dropped", b.view.Self(), why, sum.Checked, sum.Copied, sum.Dropped), nil)
	}
	return sum
}

// maxRebalanceLines caps the per-key log lines of one pass so a big join
// does not flood the event log; the summary line always follows.
const maxRebalanceLines = 25

// peerInventories asks every reachable peer what it holds, keyed by node
// and then by object key.
func (b *Rebalancer) peerInventories(ctx context.Context) map[string]map[string]store.ObjectMeta {
	self := b.view.Self()
	out := map[string]map[string]store.ObjectMeta{}
	for _, n := range b.view.Members() {
		if n == self || !b.view.Reachable(n) {
			continue
		}
		rctx, cancel := context.WithTimeout(ctx, inventoryTimeout)
		inv, err := b.view.Peer(n).Inventory(rctx)
		cancel()
		if err != nil {
			continue
		}
		idx := make(map[string]store.ObjectMeta, len(inv.Objects))
		for _, m := range inv.Objects {
			idx[m.Key] = m
		}
		out[n] = idx
	}
	return out
}

func (b *Rebalancer) boundedEmitter(limit int) func(events.Level, string, string) {
	lines := 0
	return func(level events.Level, key, msg string) {
		if lines < limit {
			b.log.Emit(events.KindRebalance, level, key, msg, nil)
		}
		lines++
	}
}

// rebalanceKey makes sure every reachable owner of one local replica holds
// it, copying where needed, and drops the local copy once this node is not
// an owner and every owner is confirmed. stopped is true when the token
// bucket wait was cancelled and the pass should end.
func (b *Rebalancer) rebalanceKey(ctx context.Context, meta store.ObjectMeta, inventories map[string]map[string]store.ObjectMeta, emit func(events.Level, string, string)) (copied, dropped int, stopped bool) {
	self := b.view.Self()
	pref, _ := replica.Preference(b.view, meta.Key, b.view.Quorum().N)
	owner := slices.Contains(pref, self)
	allHold := len(pref) > 0
	var obj *store.Object
	for _, p := range pref {
		if p == self {
			continue
		}
		idx, ok := inventories[p]
		if !b.view.Reachable(p) || !ok {
			allHold = false
			continue
		}
		if theirs, has := idx[meta.Key]; has && store.AtLeast(theirs, meta) {
			continue
		}
		if obj == nil {
			o, err := b.store.Get(meta.Key)
			if err != nil || o.Corrupt {
				// Never spread bad bytes. The scrubber will repair this copy.
				allHold = false
				break
			}
			obj = &o
		}
		if err := b.limiter.Wait(ctx); err != nil {
			return copied, dropped, true
		}
		rctx, cancel := context.WithTimeout(ctx, copyTimeout)
		_, err := b.view.Peer(p).Replicate(rctx, obj.Meta, obj.Body, "rebalance")
		cancel()
		if err != nil {
			allHold = false
			continue
		}
		copied++
		if owner {
			emit(events.LevelInfo, meta.Key, fmt.Sprintf("rebalance: copied %s from %s to %s (new owner)", meta.Key, self, p))
		} else {
			emit(events.LevelInfo, meta.Key, fmt.Sprintf("rebalance: migrate %s from %s → %s", meta.Key, self, p))
		}
	}
	if !owner && allHold {
		if ok, err := b.store.DeleteIf(meta); err == nil && ok {
			dropped++
			emit(events.LevelInfo, meta.Key, fmt.Sprintf("rebalance: dropped %s from %s; owners are now %v", meta.Key, self, pref))
		}
	}
	return copied, dropped, false
}

// TokenBucket bounds background copy work so repair and rebalance never
// starve client traffic.
type TokenBucket struct {
	mu     sync.Mutex
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

// NewTokenBucket allows rate operations per second with the given burst.
func NewTokenBucket(rate float64, burst int) *TokenBucket {
	if burst < 1 {
		burst = 1
	}
	return &TokenBucket{rate: rate, burst: float64(burst), tokens: float64(burst), last: time.Now()}
}

// Wait blocks until one token is available or ctx ends.
func (t *TokenBucket) Wait(ctx context.Context) error {
	for {
		t.mu.Lock()
		now := time.Now()
		t.tokens += now.Sub(t.last).Seconds() * t.rate
		if t.tokens > t.burst {
			t.tokens = t.burst
		}
		t.last = now
		if t.tokens >= 1 {
			t.tokens--
			t.mu.Unlock()
			return nil
		}
		wait := time.Duration((1 - t.tokens) / t.rate * float64(time.Second))
		t.mu.Unlock()
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
