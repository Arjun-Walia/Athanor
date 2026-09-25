// Package ring places objects with a consistent-hash ring.
//
// Every node owns a fixed number of virtual nodes. A key hashes to a point
// on the ring and walks clockwise to N distinct physical nodes. Membership
// and the ring version are gossiped; each node computes ownership locally.
// There is no central object index and no Raft metadata cluster.
package ring

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"sort"
	"strconv"
	"strings"
)

// DefaultVNodes is the vnode count per physical node.
// Bounded so join and leave work stays predictable.
const DefaultVNodes = 64

// ErrEmpty is returned when the ring has no members.
var ErrEmpty = errors.New("ring: no members")

// PreferenceList is the ordered owner list for one key.
type PreferenceList struct {
	Key   string
	Hash  uint64
	Nodes []string
}

// Token is one vnode position.
type Token struct {
	Hash uint64 `json:"hash"`
	Node string `json:"node"`
}

// Ring is an immutable placement view at one ring version.
type Ring struct {
	version uint64
	vnodes  int
	nodes   []string
	tokens  []Token
}

// New builds a ring over nodes with vnodes tokens each. Node order does not
// matter; the same member set always yields the same ring.
func New(nodes []string, vnodes int, version uint64) *Ring {
	if vnodes <= 0 {
		vnodes = DefaultVNodes
	}
	uniq := dedupe(nodes)
	tokens := make([]Token, 0, len(uniq)*vnodes)
	for _, node := range uniq {
		for i := 0; i < vnodes; i++ {
			tokens = append(tokens, Token{Hash: hash64(node + "#" + strconv.Itoa(i)), Node: node})
		}
	}
	sort.Slice(tokens, func(i, j int) bool {
		if tokens[i].Hash != tokens[j].Hash {
			return tokens[i].Hash < tokens[j].Hash
		}
		return tokens[i].Node < tokens[j].Node
	})
	return &Ring{version: version, vnodes: vnodes, nodes: uniq, tokens: tokens}
}

// Version is the gossiped ring version this view was built at.
func (r *Ring) Version() uint64 { return r.version }

// Nodes returns the physical members, sorted.
func (r *Ring) Nodes() []string { return append([]string(nil), r.nodes...) }

// Size is the number of physical members.
func (r *Ring) Size() int { return len(r.nodes) }

// Tokens returns every vnode position in ring order.
func (r *Ring) Tokens() []Token { return append([]Token(nil), r.tokens...) }

// Has reports whether node is a ring member.
func (r *Ring) Has(node string) bool {
	i := sort.SearchStrings(r.nodes, node)
	return i < len(r.nodes) && r.nodes[i] == node
}

// Digest identifies the member set. Two nodes with equal digests place every
// key identically.
func (r *Ring) Digest() string { return Digest(r.nodes) }

// Walk returns every physical node in clockwise order from key's position.
// The first N entries are the preference list; the rest are the fallbacks a
// sloppy quorum uses when a preferred node is down.
func (r *Ring) Walk(key string) []string {
	if len(r.tokens) == 0 {
		return nil
	}
	h := KeyHash(key)
	start := sort.Search(len(r.tokens), func(i int) bool { return r.tokens[i].Hash >= h })
	seen := make(map[string]bool, len(r.nodes))
	out := make([]string, 0, len(r.nodes))
	for i := 0; i < len(r.tokens) && len(out) < len(r.nodes); i++ {
		node := r.tokens[(start+i)%len(r.tokens)].Node
		if !seen[node] {
			seen[node] = true
			out = append(out, node)
		}
	}
	return out
}

// Preference returns the first n distinct nodes clockwise from key. It
// returns fewer than n when the ring is smaller than n.
func (r *Ring) Preference(key string, n int) (PreferenceList, error) {
	if len(r.tokens) == 0 {
		return PreferenceList{}, ErrEmpty
	}
	walk := r.Walk(key)
	if n > len(walk) {
		n = len(walk)
	}
	return PreferenceList{Key: key, Hash: KeyHash(key), Nodes: walk[:n]}, nil
}

// KeyHash is the ring position of key: the first 8 bytes of SHA-256.
func KeyHash(key string) uint64 { return hash64(key) }

// Position maps a ring hash to a fraction of one turn, 0 <= p < 1, which is
// what the dashboard draws. The same key lands at the same angle on every
// node and in the landing page's illustration.
func Position(h uint64) float64 { return float64(h) / 18446744073709551616.0 }

// Owners returns the preference list as plain ids, or nil on an empty ring.
func (r *Ring) Owners(key string, n int) []string {
	p, err := r.Preference(key, n)
	if err != nil {
		return nil
	}
	return p.Nodes
}

// Digest is a short, order-independent fingerprint of a member set.
func Digest(nodes []string) string {
	uniq := dedupe(nodes)
	sum := sha256.Sum256([]byte(strings.Join(uniq, "\x00")))
	return hex.EncodeToString(sum[:4])
}

func hash64(s string) uint64 {
	sum := sha256.Sum256([]byte(s))
	return binary.BigEndian.Uint64(sum[:8])
}

func dedupe(nodes []string) []string {
	seen := make(map[string]bool, len(nodes))
	out := make([]string, 0, len(nodes))
	for _, n := range nodes {
		if n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}
