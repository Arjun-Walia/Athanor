// Package repair is the only repair implementation in the node.
//
// Read-repair, the scrubber, and hinted-handoff replay all call
// Repairer.Repair. Rebalance is a separate rate-limited copy of keys a node
// should no longer (or should now) hold; it is not a second healing
// algorithm, and it never pushes bytes that fail their checksum.
package repair

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// Reason identifies which caller asked for repair. The dashboard event log
// prints these strings.
type Reason string

const (
	ReasonReadRepair Reason = "read-repair"
	ReasonScrub      Reason = "scrub"
	ReasonHintReplay Reason = "hint-replay"
	ReasonRebalance  Reason = "rebalance"
	ReasonManual     Reason = "manual"
)

// ErrNoHealthyReplica means every reachable copy of the key failed its
// checksum. The event log records it as data loss for that key.
var ErrNoHealthyReplica = errors.New("no healthy replica reachable")

// Report is one repair outcome.
type Report struct {
	Key      string
	Reason   Reason
	Winner   store.ObjectMeta
	Source   string
	Pushed   []string
	Corrupt  []string
	Stale    []string
	Missing  []string
	Surveyed int // members that answered the survey
	Took     time.Duration
}

// Healed reports whether the repair changed any replica.
func (r Report) Healed() bool { return len(r.Pushed) > 0 }

// Repairer heals one key across the preference list and any hint holders.
// The winner is the highest version whose payload matches its checksum.
type Repairer struct {
	view    replica.View
	log     *events.Log
	timeout time.Duration

	mu       sync.Mutex
	inflight map[string]*flight
	last     *Report
	lastAt   time.Time
	count    uint64
}

type flight struct {
	done   chan struct{}
	report Report
	err    error
}

// NewRepairer returns a repairer over view.
func NewRepairer(view replica.View, log *events.Log, timeout time.Duration) *Repairer {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	return &Repairer{view: view, log: log, timeout: timeout, inflight: map[string]*flight{}}
}

// Stats is what the metrics card shows.
type Stats struct {
	Repairs    uint64    `json:"repairs"`
	LastKey    string    `json:"last_key,omitempty"`
	LastAt     time.Time `json:"last_at,omitempty"`
	LastMicros int64     `json:"last_micros,omitempty"`
}

// Stats returns counters for repairs that pushed at least one replica.
func (r *Repairer) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := Stats{Repairs: r.count}
	if r.last != nil {
		s.LastKey = r.last.Key
		s.LastAt = r.lastAt
		s.LastMicros = r.last.Took.Microseconds()
	}
	return s
}

// Repair heals key. Concurrent calls for the same key share one run.
func (r *Repairer) Repair(ctx context.Context, key string, reason Reason) (Report, error) {
	r.mu.Lock()
	if f, ok := r.inflight[key]; ok {
		r.mu.Unlock()
		select {
		case <-f.done:
			return f.report, f.err
		case <-ctx.Done():
			return Report{}, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	r.inflight[key] = f
	r.mu.Unlock()

	f.report, f.err = r.repair(ctx, key, reason)

	r.mu.Lock()
	delete(r.inflight, key)
	if f.err == nil && f.report.Healed() {
		r.count++
		rep := f.report
		r.last = &rep
		r.lastAt = time.Now().UTC()
	}
	r.mu.Unlock()
	close(f.done)
	return f.report, f.err
}

func (r *Repairer) repair(ctx context.Context, key string, reason Reason) (Report, error) {
	start := time.Now()
	report := Report{Key: key, Reason: reason}
	q := r.view.Quorum()
	pref, _ := replica.Preference(r.view, key, q.N)
	if len(pref) == 0 {
		return report, replica.ErrEmptyRing
	}

	// Ask every reachable ring member. The cluster is small, and this finds
	// hint holders and copies stranded by a ring change as well as owners.
	replies := r.survey(ctx, key)
	report.Surveyed = len(replies)

	var winner replica.Replica
	found := false
	for _, n := range sortedKeys(replies) {
		rep := replies[n]
		if !rep.Found || rep.Corrupt {
			continue
		}
		if !found || store.Newer(rep.Meta, winner.Meta) {
			winner, found = rep, true
		}
	}
	if !found {
		for _, n := range sortedKeys(replies) {
			if replies[n].Corrupt {
				report.Corrupt = append(report.Corrupt, n)
			}
		}
		if len(report.Corrupt) > 0 {
			report.Took = time.Since(start)
			r.log.Emit(events.KindRepair, events.LevelErr, key,
				fmt.Sprintf("%s: checksum mismatch on %s and no healthy replica is reachable", key, strings.Join(report.Corrupt, ", ")),
				map[string]string{"reason": string(reason)})
			return report, ErrNoHealthyReplica
		}
		return report, nil
	}
	report.Winner = winner.Meta

	source, body, err := r.fetchWinner(ctx, key, winner.Meta, replies)
	if err != nil {
		report.Took = time.Since(start)
		return report, err
	}
	report.Source = source

	for _, p := range pref {
		if !r.view.Reachable(p) {
			continue
		}
		rep, answered := replies[p]
		if !answered {
			continue
		}
		var kind *[]string
		switch {
		case rep.Found && rep.Corrupt && !rep.Hinted:
			kind = &report.Corrupt
		case !rep.Found || rep.Hinted:
			kind = &report.Missing
		case store.Newer(winner.Meta, rep.Meta):
			kind = &report.Stale
		default:
			continue
		}
		*kind = append(*kind, p)
		rctx, cancel := context.WithTimeout(ctx, r.timeout)
		_, err := r.view.Peer(p).Replicate(rctx, winner.Meta, body, "repair:"+string(reason))
		cancel()
		if err == nil {
			report.Pushed = append(report.Pushed, p)
		}
	}
	report.Took = time.Since(start)

	if report.Healed() {
		r.log.Emit(events.KindRepair, events.LevelOK, key, describe(report),
			map[string]string{
				"reason":   string(reason),
				"source":   source,
				"pushed":   strings.Join(report.Pushed, ","),
				"micros":   fmt.Sprint(report.Took.Microseconds()),
				"version":  fmt.Sprint(winner.Meta.Version),
				"surveyed": fmt.Sprint(report.Surveyed),
			})
	}
	return report, nil
}

func (r *Repairer) survey(ctx context.Context, key string) map[string]replica.Replica {
	type answer struct {
		node string
		rep  replica.Replica
		err  error
	}
	members := r.view.Members()
	ch := make(chan answer, len(members))
	asked := 0
	for _, n := range members {
		if !r.view.Reachable(n) {
			continue
		}
		asked++
		go func(n string) {
			rctx, cancel := context.WithTimeout(ctx, r.timeout)
			defer cancel()
			rep, err := r.view.Peer(n).GetReplica(rctx, key, false)
			ch <- answer{node: n, rep: rep, err: err}
		}(n)
	}
	out := make(map[string]replica.Replica, asked)
	for i := 0; i < asked; i++ {
		a := <-ch
		if a.err == nil {
			out[a.node] = a.rep
		}
	}
	return out
}

// fetchWinner reads the winning version's bytes from a node that holds it,
// preferring the local node, and re-verifies them before anything is pushed.
func (r *Repairer) fetchWinner(ctx context.Context, key string, winner store.ObjectMeta, replies map[string]replica.Replica) (string, []byte, error) {
	var holders []string
	if rep, ok := replies[r.view.Self()]; ok && rep.Found && !rep.Corrupt && store.SameVersion(rep.Meta, winner) {
		holders = append(holders, r.view.Self())
	}
	for _, n := range sortedKeys(replies) {
		rep := replies[n]
		if n != r.view.Self() && rep.Found && !rep.Corrupt && store.SameVersion(rep.Meta, winner) {
			holders = append(holders, n)
		}
	}
	for _, n := range holders {
		if winner.Deleted {
			return n, nil, nil
		}
		rctx, cancel := context.WithTimeout(ctx, r.timeout)
		rep, err := r.view.Peer(n).GetReplica(rctx, key, true)
		cancel()
		if err != nil || rep.Corrupt || !store.SameVersion(rep.Meta, winner) {
			continue
		}
		if store.Checksum(rep.Body) != winner.Checksum {
			continue
		}
		return n, rep.Body, nil
	}
	return "", nil, fmt.Errorf("repair %s: winner v%d could not be read back", key, winner.Version)
}

func describe(rep Report) string {
	var parts []string
	if len(rep.Corrupt) > 0 {
		parts = append(parts, "checksum mismatch on "+strings.Join(rep.Corrupt, ", "))
	}
	if len(rep.Missing) > 0 {
		parts = append(parts, strings.Join(rep.Missing, ", ")+" missing")
	}
	if len(rep.Stale) > 0 {
		parts = append(parts, strings.Join(rep.Stale, ", ")+" stale")
	}
	what := "healed"
	if rep.Winner.Deleted {
		what = "tombstone"
	}
	return fmt.Sprintf("%s: %s → %s from %s to %s (%s, %s)",
		rep.Key, strings.Join(parts, "; "), what, rep.Source, strings.Join(rep.Pushed, ", "), rep.Reason, roundDur(rep.Took))
}

func sortedKeys(m map[string]replica.Replica) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func roundDur(d time.Duration) string {
	switch {
	case d < time.Millisecond:
		return d.Round(time.Microsecond).String()
	case d < time.Second:
		return d.Round(100 * time.Microsecond).String()
	default:
		return d.Round(time.Millisecond).String()
	}
}
