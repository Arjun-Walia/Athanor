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

	// Retry is how long to wait before asking a preferred node a second
	// time when its first answer was an error. One retry covers the usual
	// transient causes (a connection that was half-open when the peer
	// restarted, a probe-timeout race) without turning a dead node into a
	// slow write: the fallback path still runs if the retry fails too.
	Retry time.Duration

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
	return &Coordinator{view: view, clock: clock, log: log, timeout: timeout, Retry: 150 * time.Millisecond}
}

// withRetry runs op, and once more after Retry if it failed and the peer is
// still considered reachable. A second failure is returned as is.
func (c *Coordinator) withRetry(ctx context.Context, target string, op func() error) error {
	err := op()
	if err == nil || c.Retry <= 0 {
		return err
	}
	select {
	case <-ctx.Done():
		return err
	case <-time.After(c.Retry):
	}
	if !c.view.Reachable(target) {
		return err
	}
	return op()
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

// graceAfterTimeout is how long a coordinator keeps listening past the
// per-replica timeout before it stops counting answers.
const graceAfterTimeout = 500 * time.Millisecond

var errUnreachable = errors.New("unreachable")

// fallbacks hands out sloppy-quorum fallback nodes in ring order, one per
// unreachable preferred node, so a hint lands on the next healthy node
// clockwise. It is shared by the goroutines of one request.
type fallbacks struct {
	mu    sync.Mutex
	view  View
	queue []string
}

func (f *fallbacks) next() (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for len(f.queue) > 0 {
		fb := f.queue[0]
		f.queue = f.queue[1:]
		if f.view.Reachable(fb) {
			return fb, true
		}
	}
	return "", false
}

func (c *Coordinator) write(ctx context.Context, op string, meta store.ObjectMeta, body []byte) (WriteResult, error) {
	start := time.Now()
	q := c.view.Quorum()
	pref, spare := Preference(c.view, meta.Key, q.N)
	if len(pref) == 0 {
		return WriteResult{}, ErrEmptyRing
	}
	fb := &fallbacks{view: c.view, queue: spare}
	results := make(chan writeOutcome, len(pref))
	for _, target := range pref {
		go c.writeOne(target, op, meta, body, fb, results)
	}
	acks, failed := c.collectAcks(ctx, results, len(pref), q.W)

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
		fmt.Sprintf("%s %s acked by %s (W=%d of N=%d) in %s", op, meta.Key, strings.Join(ackLabels(acks), ", "), q.W, len(pref), RoundDuration(took)),
		map[string]string{"op": op, "version": fmt.Sprint(meta.Version), "preference": strings.Join(pref, ",")})
	return res, nil
}

// writeOne replicates to one preferred node, or parks a hint for it on the
// next reachable fallback. It sends exactly one outcome.
func (c *Coordinator) writeOne(target, op string, meta store.ObjectMeta, body []byte, fb *fallbacks, results chan<- writeOutcome) {
	rctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	began := time.Now()
	lastErr := errUnreachable
	if c.view.Reachable(target) {
		lastErr = c.withRetry(rctx, target, func() error {
			_, err := c.view.Peer(target).Replicate(rctx, meta, body, op)
			return err
		})
		if lastErr == nil {
			results <- writeOutcome{ok: true, node: target, ack: Ack{Node: target, Took: time.Since(began)}}
			return
		}
	}
	for {
		holder, ok := fb.next()
		if !ok {
			results <- writeOutcome{node: target, err: lastErr}
			return
		}
		if err := c.view.Peer(holder).Hint(rctx, target, meta, body); err != nil {
			lastErr = err
			continue
		}
		c.log.Emit(events.KindHint, events.LevelWarn, meta.Key,
			fmt.Sprintf("%s is unreachable; parked %s for it on %s", target, meta.Key, holder),
			map[string]string{"target": target, "holder": holder, "version": fmt.Sprint(meta.Version)})
		results <- writeOutcome{ok: true, node: holder, ack: Ack{Node: holder, HintFor: target, Took: time.Since(began)}}
		return
	}
}

// collectAcks waits until W acks arrived, every slot answered, the client
// gave up, or the deadline passed, whichever comes first.
func (c *Coordinator) collectAcks(ctx context.Context, results <-chan writeOutcome, slots, need int) (acks []Ack, failed []string) {
	wait := time.NewTimer(c.timeout + graceAfterTimeout)
	defer wait.Stop()
	for received := 0; received < slots; received++ {
		select {
		case r := <-results:
			if !r.ok {
				failed = append(failed, r.node)
				continue
			}
			acks = append(acks, r.ack)
			if len(acks) >= need {
				return acks, failed
			}
		case <-ctx.Done():
			return acks, failed
		case <-wait.C:
			return acks, failed
		}
	}
	return acks, failed
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

// countsTowardR reports whether an answer is evidence for the read quorum:
// a preferred node answered (found or not), or a fallback actually held a
// copy. A fallback that holds nothing is no evidence the key is absent.
func countsTowardR(r readOutcome) bool {
	if r.err != nil || r.rep.Corrupt {
		return false
	}
	return r.cand.primary || r.rep.Found
}

// Get reads R replicas and returns the newest one whose bytes verify.
func (c *Coordinator) Get(ctx context.Context, key string) (ReadResult, error) {
	start := time.Now()
	q := c.view.Quorum()
	pref, spare := Preference(c.view, key, q.N)
	if len(pref) == 0 {
		return ReadResult{}, ErrEmptyRing
	}
	// One goroutine per preferred slot. A slot asks its preferred node; if
	// that node is unreachable or fails, it asks the next healthy fallback,
	// which may hold a hint for it (a sloppy read).
	fb := &fallbacks{view: c.view, queue: spare}
	results := make(chan readOutcome, len(pref))
	for _, p := range pref {
		go c.readOne(p, key, fb, results)
	}
	got, valid := c.collectReads(ctx, results, len(pref), q.R)
	// Keep listening in the background so replicas that answer after the
	// quorum still get compared, and read-repair sees the full picture.
	go c.watchLateReplies(key, got, results, len(pref)-len(got))

	res := ReadResult{Preference: pref, Quorum: q, Coordinator: c.view.Self(), Degraded: c.anyUnreachable(pref)}
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

// readOne asks one preferred node, then its fallbacks, and sends exactly
// one outcome.
func (c *Coordinator) readOne(p, key string, fb *fallbacks, results chan<- readOutcome) {
	rctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	lastErr := errUnreachable
	if c.view.Reachable(p) {
		var rep Replica
		lastErr = c.withRetry(rctx, p, func() error {
			var err error
			rep, err = c.view.Peer(p).GetReplica(rctx, key, true)
			return err
		})
		if lastErr == nil {
			results <- readOutcome{cand: readCandidate{node: p, primary: true}, rep: rep}
			return
		}
	}
	for {
		holder, ok := fb.next()
		if !ok {
			results <- readOutcome{cand: readCandidate{node: p, primary: true}, err: lastErr}
			return
		}
		rep, err := c.view.Peer(holder).GetReplica(rctx, key, true)
		if err != nil {
			lastErr = err
			continue
		}
		results <- readOutcome{cand: readCandidate{node: holder, forNode: p}, rep: rep}
		return
	}
}

// collectReads gathers answers until R of them count, every slot answered,
// the client gave up, or the deadline passed.
func (c *Coordinator) collectReads(ctx context.Context, results <-chan readOutcome, slots, need int) (got []readOutcome, valid int) {
	wait := time.NewTimer(c.timeout + graceAfterTimeout)
	defer wait.Stop()
	for len(got) < slots {
		select {
		case r := <-results:
			got = append(got, r)
			if countsTowardR(r) {
				valid++
			}
			if valid >= need {
				return got, valid
			}
		case <-ctx.Done():
			return got, valid
		case <-wait.C:
			return got, valid
		}
	}
	return got, valid
}

// watchLateReplies drains the answers that arrive after the quorum was
// met, then hands the whole picture to read-repair.
func (c *Coordinator) watchLateReplies(key string, first []readOutcome, results <-chan readOutcome, remaining int) {
	all := append([]readOutcome(nil), first...)
	timeout := time.NewTimer(c.timeout + graceAfterTimeout)
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
}

func (c *Coordinator) anyUnreachable(nodes []string) bool {
	for _, p := range nodes {
		if !c.view.Reachable(p) {
			return true
		}
	}
	return false
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

// RoundDuration formats a latency for the event log: microseconds under a
// millisecond, tenths of a millisecond under a second, milliseconds above.
func RoundDuration(d time.Duration) string {
	switch {
	case d < time.Millisecond:
		return d.Round(time.Microsecond).String()
	case d < time.Second:
		return d.Round(100 * time.Microsecond).String()
	default:
		return d.Round(time.Millisecond).String()
	}
}
