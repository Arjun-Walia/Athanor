package replica

// Coordinator is the client-facing put, get, and delete path.
// Phase B implements it against the preference list. Phase A may satisfy
// Put and Get from the local store before peers exist.
type Coordinator interface {
	Put(key string, body []byte) error
	Get(key string) ([]byte, error)
	Delete(key string) error
}
