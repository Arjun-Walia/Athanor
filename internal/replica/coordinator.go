package replica

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// ErrNotFound means a read quorum agreed the key does not exist (or its
// newest version is a tombstone).
var ErrNotFound = errors.New("not found")

// ErrEmptyRing means this node knows no ring members yet.
var ErrEmptyRing = errors.New("ring has no members yet")

// QuorumError is a write or read that could not collect enough replicas.
type QuorumError struct {
	Op    string
	Got   int
	Need  int
	Nodes []string
}

func (e *QuorumError) Error() string {
	return fmt.Sprintf("%s quorum not reached: %d of %d replicas answered", e.Op, e.Got, e.Need)
}

// Ack is one replica that durably holds a write.
type Ack struct {
	Node    string        `json:"node"`
	HintFor string        `json:"hint_for,omitempty"`
	Took    time.Duration `json:"-"`
}

// WriteResult describes a successful put or delete.
type WriteResult struct {
	Meta        store.ObjectMeta
	Preference  []string
	Acks        []Ack
	Quorum      Quorum
	Coordinator string
	Took        time.Duration
}

// ReplicaStatus is how one replica compared with the read winner.
type ReplicaStatus struct {
	Node    string `json:"node"`
	Status  string `json:"status"` // ok, stale, missing, corrupt, hint
	Version uint64 `json:"version,omitempty"`
	HintFor string `json:"hint_for,omitempty"`
}

// ReadResult describes a successful get.
type ReadResult struct {
	Meta        store.ObjectMeta
	Body        []byte
	Preference  []string
	Replicas    []ReplicaStatus
	Quorum      Quorum
	Degraded    bool // a preferred node was unreachable or a hint served the read
	Coordinator string
	Took        time.Duration
}

// Coordinator is the client-facing put, get, and delete path.
type Coordinator struct {
	view    View
	clock   *Clock
	log     *events.Log
	timeout time.Duration

	// OnDivergence is called (asynchronously) when a read finds a reachable
	// preferred replica that is missing, stale, or corrupt. The node wires it
	// to Repair, so read-repair uses the same code as the scrubber.
	OnDivergence func(key, why string)
}

// NewCoordinator returns a coordinator. timeout bounds each replica RPC.
func NewCoordinator(view View, clock *Clock, log *events.Log, timeout time.Duration) *Coordinator {
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	return &Coordinator{view: view, clock: clock, log: log, timeout: timeout}
}

// Put writes body under key and returns after W replicas acknowledge.
func (c *Coordinator) Put(ctx context.Context, key string, body []byte, contentType string) (WriteResult, error) {
	meta := store.ObjectMeta{
		Key:         key,
		Version:     c.clock.Next(),
		Checksum:    store.Checksum(body),
		Size:        uint64(len(body)),
		Origin:      c.view.Self(),
		WrittenAt:   time.Now().UTC(),
		ContentType: contentType,
	}
	return c.write(ctx, "put", meta, body)
}

// Delete writes a tombstone. Tombstones replicate and repair like any other
// version, so a stale replica cannot resurrect the key.
func (c *Coordinator) Delete(ctx context.Context, key string) (WriteResult, error) {
	meta := store.ObjectMeta{
		Key:       key,
		Version:   c.clock.Next(),
		Checksum:  store.Checksum(nil),
		Origin:    c.view.Self(),
		Deleted:   true,
		WrittenAt: time.Now().UTC(),
	}
	return c.write(ctx, "delete", meta, nil)
}

type writeOutcome struct {
	ack  Ack
	ok   bool
	node string
	err  error
}

func (c *Coordinator) write(ctx context.Context, op string, meta store.ObjectMeta, body []byte) (WriteResult, error) {
	start := time.Now()
	q := c.view.Quorum()
	pref, fallbacks := Preference(c.view, meta.Key, q.N)
	if len(pref) == 0 {
		return WriteResult{}, ErrEmptyRing
	}

	// Fallback nodes are handed out in ring order, one per unreachable
	// preferred node, so a hint lands on the next healthy node clockwise.
	var fbMu sync.Mutex
	nextFallback := func() (string, bool) {
		fbMu.Lock()
		defer fbMu.Unlock()
		for len(fallbacks) > 0 {
			fb := fallbacks[0]
			fallbacks = fallbacks[1:]
			if c.view.Reachable(fb) {
				return fb, true
			}
		}
		return "", false
	}

	results := make(chan writeOutcome, len(pref))
	for _, target := range pref {
		go func(target string) {
			rctx, cancel := context.WithTimeout(context.Background(), c.timeout)
			defer cancel()
			began := time.Now()
			var lastErr error
			if c.view.Reachable(target) {
				_, err := c.view.Peer(target).Replicate(rctx, meta, body, op)
				if err == nil {
					results <- writeOutcome{ok: true, node: target, ack: Ack{Node: target, Took: time.Since(began)}}
					return
				}
				lastErr = err
			} else {
				lastErr = errors.New("unreachable")
			}
			for {
				fb, ok := nextFallback()
				if !ok {
					results <- writeOutcome{node: target, err: lastErr}
					return
				}
				if err := c.view.Peer(fb).Hint(rctx, target, meta, body); err != nil {
					lastErr = err
					continue
				}
				c.log.Emit(events.KindHint, events.LevelWarn, meta.Key,
					fmt.Sprintf("%s is unreachable; parked %s for it on %s", target, meta.Key, fb),
					map[string]string{"target": target, "holder": fb, "version": fmt.Sprint(meta.Version)})
				results <- writeOutcome{ok: true, node: fb, ack: Ack{Node: fb, HintFor: target, Took: time.Since(began)}}
				return
			}
		}(target)
	}

	var acks []Ack
	var failed []string
	wait := time.NewTimer(c.timeout + 500*time.Millisecond)
	defer wait.Stop()
collect:
	for received := 0; received < len(pref); received++ {
		select {
		case r := <-results:
			if r.ok {
				acks = append(acks, r.ack)
				if len(acks) >= q.W {
					break collect
				}
			} else {
				failed = append(failed, r.node)
			}
		case <-ctx.Done():
			break collect
		case <-wait.C:
			break collect
		}
	}

	took := time.Since(start)
	res := WriteResult{Meta: meta, Preference: pref, Acks: acks, Quorum: q, Coordinator: c.view.Self(), Took: took}
	if len(acks) < q.W {
		c.log.Emit(events.KindWrite, events.LevelErr, meta.Key,
			fmt.Sprintf("%s %s failed: %d of W=%d acks (unreachable: %s)", op, meta.Key, len(acks), q.W, joinOrNone(failed)),
			map[string]string{"op": op})
		return res, &QuorumError{Op: "write", Got: len(acks), Need: q.W, Nodes: ackNodes(acks)}
	}
	level := events.LevelOK
	if hinted(acks) {
		level = events.LevelWarn
	}
	c.log.Emit(events.KindWrite, level, meta.Key,
		fmt.Sprintf("%s %s acked by %s (W=%d of N=%d) in %s", op, meta.Key, strings.Join(ackLabels(acks), ", "), q.W, len(pref), roundDur(took)),
		map[string]string{"op": op, "version": fmt.Sprint(meta.Version), "preference": strings.Join(pref, ",")})
	return res, nil
}

type readCandidate struct {
	node    string
	primary bool
	forNode string // the preferred node this fallback stands in for
}

type readOutcome struct {
	cand readCandidate
	rep  Replica
	err  error
}

// Get reads R replicas and returns the newest one whose bytes verify.
func (c *Coordinator) Get(ctx context.Context, key string) (ReadResult, error) {
	start := time.Now()
	q := c.view.Quorum()
	pref, fallbacks := Preference(c.view, key, q.N)
	if len(pref) == 0 {
		return ReadResult{}, ErrEmptyRing
	}

	// One goroutine per preferred slot. A slot asks its preferred node; if
	// that node is unreachable or fails, it asks the next healthy fallback,
	// which may hold a hint for it (a sloppy read).
	var fbMu sync.Mutex
	nextFallback := func() (string, bool) {
		fbMu.Lock()
		defer fbMu.Unlock()
		for len(fallbacks) > 0 {
			fb := fallbacks[0]
			fallbacks = fallbacks[1:]
			if c.view.Reachable(fb) {
				return fb, true
			}
		}
		return "", false
	}
	results := make(chan readOutcome, len(pref))
	for _, p := range pref {
		go func(p string) {
			rctx, cancel := context.WithTimeout(context.Background(), c.timeout)
			defer cancel()
			var lastErr error
			if c.view.Reachable(p) {
				rep, err := c.view.Peer(p).GetReplica(rctx, key, true)
				if err == nil {
					results <- readOutcome{cand: readCandidate{node: p, primary: true}, rep: rep}
					return
				}
				lastErr = err
			} else {
				lastErr = errors.New("unreachable")
			}
			for {
				fb, ok := nextFallback()
				if !ok {
					results <- readOutcome{cand: readCandidate{node: p, primary: true}, err: lastErr}
					return
				}
				rep, err := c.view.Peer(fb).GetReplica(rctx, key, true)
				if err != nil {
					lastErr = err
					continue
				}
				results <- readOutcome{cand: readCandidate{node: fb, forNode: p}, rep: rep}
				return
			}
		}(p)
	}

	// A response counts toward R when a preferred node answered (found or
	// not), or a fallback actually held a copy. A fallback that holds
	// nothing is no evidence the key is absent.
	counts := func(r readOutcome) bool {
		if r.err != nil || r.rep.Corrupt {
			return false
		}
		return r.cand.primary || r.rep.Found
	}
	var got []readOutcome
	valid := 0
	wait := time.NewTimer(c.timeout + 500*time.Millisecond)
	defer wait.Stop()
collect:
	for len(got) < len(pref) {
		select {
		case r := <-results:
			got = append(got, r)
			if counts(r) {
				valid++
			}
			if valid >= q.R {
				break collect
			}
		case <-ctx.Done():
			break collect
		case <-wait.C:
			break collect
		}
	}

	// Keep listening in the background so replicas that answer after the
	// quorum still get compared, and read-repair sees the full picture.
	remaining := len(pref) - len(got)
	first := append([]readOutcome(nil), got...)
	go func() {
		all := first
		timeout := time.NewTimer(c.timeout + 500*time.Millisecond)
		defer timeout.Stop()
		for i := 0; i < remaining; i++ {
			select {
			case r := <-results:
				all = append(all, r)
			case <-timeout.C:
				i = remaining
			}
		}
		c.checkDivergence(key, all)
	}()

	res := ReadResult{Preference: pref, Quorum: q, Coordinator: c.view.Self()}
	for _, p := range pref {
		if !c.view.Reachable(p) {
			res.Degraded = true
		}
	}
	if valid < q.R {
		res.Took = time.Since(start)
		return res, &QuorumError{Op: "read", Got: valid, Need: q.R, Nodes: outcomeNodes(got)}
	}

	winner, ok := newest(got)
	res.Replicas = statuses(got, winner, ok)
	res.Took = time.Since(start)
	for _, s := range res.Replicas {
		if s.Status == "hint" || s.Status == "unreachable" {
			res.Degraded = true
		}
	}
	if !ok || winner.Meta.Deleted {
		if ok {
			res.Meta = winner.Meta
		}
		return res, ErrNotFound
	}
	res.Meta = winner.Meta
	res.Body = winner.Body
	c.clock.Observe(winner.Meta.Version)
	if res.Degraded {
		c.log.Emit(events.KindRead, events.LevelWarn, key,
			fmt.Sprintf("get %s served degraded: R=%d from %s", key, q.R, strings.Join(statusLabels(res.Replicas), ", ")), nil)
	}
	return res, nil
}

func (c *Coordinator) checkDivergence(key string, all []readOutcome) {
	if c.OnDivergence == nil {
		return
	}
	winner, ok := newest(all)
	if !ok {
		// Nothing valid anywhere; a corrupt-only key still deserves a repair
		// attempt so the event log records the loss.
		for _, r := range all {
			if r.err == nil && r.rep.Corrupt {
				c.OnDivergence(key, fmt.Sprintf("checksum mismatch on %s", r.cand.node))
				return
			}
		}
		return
	}
	var why []string
	for _, r := range all {
		if r.err != nil || !r.cand.primary {
			continue
		}
		switch {
		case r.rep.Corrupt:
			why = append(why, "checksum mismatch on "+r.cand.node)
		case !r.rep.Found || r.rep.Hinted:
			why = append(why, r.cand.node+" missing")
		case store.Newer(winner.Meta, r.rep.Meta):
			why = append(why, r.cand.node+" stale")
		}
	}
	if len(why) > 0 {
		c.OnDivergence(key, strings.Join(why, ", "))
	}
}

// newest picks the highest version whose bytes verified.
func newest(outs []readOutcome) (Replica, bool) {
	var best Replica
	found := false
	for _, r := range outs {
		if r.err != nil || r.rep.Corrupt || !r.rep.Found {
			continue
		}
		if !found || store.Newer(r.rep.Meta, best.Meta) {
			best, found = r.rep, true
		}
	}
	return best, found
}

func statuses(outs []readOutcome, winner Replica, ok bool) []ReplicaStatus {
	var out []ReplicaStatus
	for _, r := range outs {
		s := ReplicaStatus{Node: r.cand.node}
		switch {
		case r.err != nil:
			s.Status = "unreachable"
		case r.rep.Corrupt:
			s.Status = "corrupt"
			s.Version = r.rep.Meta.Version
		case !r.rep.Found && !r.cand.primary:
			s.Status = "no-hint"
			s.HintFor = r.cand.forNode
		case !r.rep.Found:
			s.Status = "missing"
		case r.rep.Hinted || !r.cand.primary:
			s.Status = "hint"
			s.Version = r.rep.Meta.Version
			s.HintFor = r.cand.forNode
		case ok && store.Newer(winner.Meta, r.rep.Meta):
			s.Status = "stale"
			s.Version = r.rep.Meta.Version
		default:
			s.Status = "ok"
			s.Version = r.rep.Meta.Version
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Node < out[j].Node })
	return out
}

func hinted(acks []Ack) bool {
	for _, a := range acks {
		if a.HintFor != "" {
			return true
		}
	}
	return false
}

func ackNodes(acks []Ack) []string {
	out := make([]string, 0, len(acks))
	for _, a := range acks {
		out = append(out, a.Node)
	}
	return out
}

func ackLabels(acks []Ack) []string {
	out := make([]string, 0, len(acks))
	for _, a := range acks {
		if a.HintFor != "" {
			out = append(out, fmt.Sprintf("%s (hint for %s)", a.Node, a.HintFor))
		} else {
			out = append(out, a.Node)
		}
	}
	return out
}

func statusLabels(ss []ReplicaStatus) []string {
	out := make([]string, 0, len(ss))
	for _, s := range ss {
		if s.HintFor != "" {
			out = append(out, fmt.Sprintf("%s %s for %s", s.Node, s.Status, s.HintFor))
		} else {
			out = append(out, s.Node+" "+s.Status)
		}
	}
	return out
}

func outcomeNodes(outs []readOutcome) []string {
	var out []string
	for _, r := range outs {
		if r.err == nil && !r.rep.Corrupt {
			out = append(out, r.cand.node)
		}
	}
	return out
}

func joinOrNone(s []string) string {
	if len(s) == 0 {
		return "none"
	}
	return strings.Join(s, ", ")
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
