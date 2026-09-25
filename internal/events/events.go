// Package events is the append-only operational log each node keeps.
//
// Every repair, hint, rebalance move, membership change, and fault action is
// recorded here. The dashboard merges the logs of all reachable nodes into
// one timeline. The log is in memory and bounded; it is a demo surface, not
// an audit trail, and it is empty again after a process restart.
package events

import (
	"fmt"
	"log"
	"sync"
	"time"
)

// Kind groups events for filtering in the dashboard.
type Kind string

const (
	KindMembership Kind = "membership"
	KindWrite      Kind = "write"
	KindRead       Kind = "read"
	KindHint       Kind = "hint"
	KindRepair     Kind = "repair"
	KindScrub      Kind = "scrub"
	KindRebalance  Kind = "rebalance"
	KindFault      Kind = "fault"
	KindConfig     Kind = "config"
)

// Level is the severity shown next to an event.
type Level string

const (
	LevelInfo Level = "info"
	LevelOK   Level = "ok"
	LevelWarn Level = "warn"
	LevelErr  Level = "error"
)

// Event is one log line.
type Event struct {
	Seq     uint64            `json:"seq"`
	At      time.Time         `json:"at"`
	Node    string            `json:"node"`
	Kind    Kind              `json:"kind"`
	Level   Level             `json:"level"`
	Key     string            `json:"key,omitempty"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

// Log is a bounded, concurrency-safe ring of events for one node.
type Log struct {
	node  string
	quiet bool

	mu     sync.Mutex
	seq    uint64
	buf    []Event
	next   int
	filled bool
}

// DefaultCapacity is how many events a node keeps.
const DefaultCapacity = 1000

// New returns an empty log for node. When quiet is false every event is
// also written to the process log so `docker compose logs` shows it.
func New(node string, capacity int, quiet bool) *Log {
	if capacity <= 0 {
		capacity = DefaultCapacity
	}
	return &Log{node: node, quiet: quiet, buf: make([]Event, capacity)}
}

// Node is the id stamped on every event.
func (l *Log) Node() string { return l.node }

// Emit appends an event and returns it.
func (l *Log) Emit(kind Kind, level Level, key, message string, fields map[string]string) Event {
	l.mu.Lock()
	l.seq++
	ev := Event{
		Seq:     l.seq,
		At:      time.Now().UTC(),
		Node:    l.node,
		Kind:    kind,
		Level:   level,
		Key:     key,
		Message: message,
		Fields:  fields,
	}
	l.buf[l.next] = ev
	l.next = (l.next + 1) % len(l.buf)
	if l.next == 0 {
		l.filled = true
	}
	l.mu.Unlock()

	if !l.quiet {
		log.Printf("event %s %-10s %-5s %s", l.node, kind, level, message)
	}
	return ev
}

// Emitf is Emit with a formatted message and no extra fields.
func (l *Log) Emitf(kind Kind, level Level, key, format string, args ...any) Event {
	return l.Emit(kind, level, key, fmt.Sprintf(format, args...), nil)
}

// Since returns events with Seq > since, oldest first, capped at limit
// (the newest ones win when capped). limit <= 0 means no cap.
func (l *Log) Since(since uint64, limit int) []Event {
	l.mu.Lock()
	defer l.mu.Unlock()

	var ordered []Event
	if l.filled {
		ordered = append(ordered, l.buf[l.next:]...)
	}
	ordered = append(ordered, l.buf[:l.next]...)

	out := make([]Event, 0, len(ordered))
	for _, ev := range ordered {
		if ev.Seq > since {
			out = append(out, ev)
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

// Last returns the most recent event of kind, if any.
func (l *Log) Last(kind Kind) (Event, bool) {
	events := l.Since(0, 0)
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Kind == kind {
			return events[i], true
		}
	}
	return Event{}, false
}
