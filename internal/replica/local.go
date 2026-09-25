package replica

import (
	"context"
	"errors"

	"github.com/Arjun-Walia/Athanor/internal/store"
)

// LocalPeer serves Peer calls from this node's own store. The gRPC server
// delegates to it too, so local and remote replicas behave identically, and
// a node that coordinates a write for a key it owns takes the same path as
// any other owner.
type LocalPeer struct {
	Node  string
	Store *store.Disk
	Clock *Clock
}

// ID is the node id.
func (p *LocalPeer) ID() string { return p.Node }

// Replicate stores a primary replica if it supersedes (or heals) ours.
func (p *LocalPeer) Replicate(_ context.Context, meta store.ObjectMeta, body []byte, _ string) (store.PutResult, error) {
	if p.Clock != nil {
		p.Clock.Observe(meta.Version)
	}
	return p.Store.Put(meta, body)
}

// GetReplica returns the primary copy, or a parked hint when the hint is
// the better copy (no primary, a corrupt primary, or an older primary).
func (p *LocalPeer) GetReplica(_ context.Context, key string, withBody bool) (Replica, error) {
	primary, perr := p.Store.Get(key)
	if perr != nil && !errors.Is(perr, store.ErrNotFound) {
		return Replica{}, perr
	}
	hint, herr := p.Store.FindHint(key)
	if herr != nil && !errors.Is(herr, store.ErrNotFound) {
		return Replica{}, herr
	}
	havePrimary := perr == nil
	haveHint := herr == nil

	obj, hinted := primary, false
	switch {
	case !havePrimary && !haveHint:
		return Replica{Node: p.Node}, nil
	case !havePrimary:
		obj, hinted = hint, true
	case haveHint && (primary.Corrupt || store.Newer(hint.Meta, primary.Meta)):
		obj, hinted = hint, true
	}
	rep := Replica{Node: p.Node, Found: true, Meta: obj.Meta, Corrupt: obj.Corrupt, Hinted: hinted}
	if withBody && !obj.Corrupt {
		rep.Body = obj.Body
	}
	return rep, nil
}

// Hint parks a write for target.
func (p *LocalPeer) Hint(_ context.Context, target string, meta store.ObjectMeta, body []byte) error {
	if p.Clock != nil {
		p.Clock.Observe(meta.Version)
	}
	_, err := p.Store.PutHint(target, meta, body)
	return err
}

// Inventory lists the local index, hints, and flipped keys.
func (p *LocalPeer) Inventory(_ context.Context) (Inventory, error) {
	objs, err := p.Store.List()
	if err != nil {
		return Inventory{}, err
	}
	hints, err := p.Store.ListHints()
	if err != nil {
		return Inventory{}, err
	}
	stats, err := p.Store.Stats()
	if err != nil {
		return Inventory{}, err
	}
	inv := Inventory{Node: p.Node, Objects: objs, Tampered: p.Store.Tampered(), Bytes: stats.Bytes + stats.HintBytes, IndexErrors: stats.IndexErrors}
	for _, h := range hints {
		inv.Hints = append(inv.Hints, h.Meta)
	}
	return inv, nil
}
