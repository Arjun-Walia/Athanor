// Package store is one node's local blobs and bbolt index.
//
// On-disk layout, filled in during Phase A:
//
//	data/<first2>/<key>   payload
//	index.db              object meta + hinted-handoff queue
//
// Payloads are content-addressed by the SHA-256 stored on ObjectMeta.
// The index is the source of truth for which local files are live replicas.
package store

// ObjectMeta is the index record stored beside each local replica.
// Version is a per-object last-writer-wins clock, not a version vector.
type ObjectMeta struct {
	Key       string
	Version   uint64
	Checksum  [32]byte // SHA-256 of the payload
	Size      uint64
	Origin    string // node id that assigned Version
	HintedFor string // empty when this copy is a primary replica
}

// Object is one local replica.
type Object struct {
	Meta ObjectMeta
	Body []byte
}

// Hint is a write parked for a preferred node that was unreachable.
type Hint struct {
	Key    string
	Target string
	Meta   ObjectMeta
}

// Store is the local disk API used by replication and repair.
type Store interface {
	Put(meta ObjectMeta, body []byte) error
	Get(key string) (Object, error)
	Delete(key string) error
	List() ([]ObjectMeta, error)
	EnqueueHint(hint Hint) error
	ListHints(target string) ([]Hint, error)
}
