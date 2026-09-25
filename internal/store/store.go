// Package store is one node's local blobs and bbolt index.
//
// On-disk layout:
//
//	blobs/<first2>/<sha256(key)>.<version>           primary replica payload
//	hints/<target>/<first2>/<sha256(key)>.<version>  parked hinted-handoff payload
//	index.db                                         bbolt: object meta + hint queue
//
// File names come from the key's hash so keys may contain slashes or any other
// byte. Each payload file is written to a temporary name, fsynced, and renamed
// into place before the index points at it, so a crash leaves at worst an
// orphan file, never an index entry for half-written bytes.
//
// The index is the source of truth for which local files are live replicas.
// Every read re-hashes the payload against the SHA-256 in the index.
package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"
)

// ErrNotFound means this node holds no copy of the key.
var ErrNotFound = errors.New("store: not found")

var (
	bucketObjects = []byte("objects")
	bucketHints   = []byte("hints")
)

// ObjectMeta is the index record stored beside each local replica.
// Version is a per-object last-writer-wins clock, not a version vector.
type ObjectMeta struct {
	Key         string
	Version     uint64
	Checksum    [32]byte // SHA-256 of the payload
	Size        uint64
	Origin      string // node id that assigned Version
	HintedFor   string // empty when this copy is a primary replica
	Deleted     bool   // tombstone: the key was deleted at Version
	WrittenAt   time.Time
	ContentType string
}

// ChecksumHex is the payload SHA-256 as lowercase hex.
func (m ObjectMeta) ChecksumHex() string { return hex.EncodeToString(m.Checksum[:]) }

// Checksum is the SHA-256 every replica is verified against.
func Checksum(body []byte) [32]byte { return sha256.Sum256(body) }

// Newer reports whether a supersedes b under last-writer-wins. Versions are
// compared first; equal versions fall back to the origin node id so every
// node picks the same winner.
func Newer(a, b ObjectMeta) bool {
	if a.Version != b.Version {
		return a.Version > b.Version
	}
	return a.Origin > b.Origin
}

// SameVersion reports whether a and b are the same write.
func SameVersion(a, b ObjectMeta) bool {
	return a.Version == b.Version && a.Origin == b.Origin
}

// AtLeast reports whether a is the same write as b or supersedes it.
func AtLeast(a, b ObjectMeta) bool { return SameVersion(a, b) || Newer(a, b) }

// Object is one local replica. Corrupt is set when the payload on disk does
// not hash to Meta.Checksum, or the payload file is missing.
type Object struct {
	Meta    ObjectMeta
	Body    []byte
	Corrupt bool
}

// PutResult says whether a write changed the replica and what the replica
// holds afterwards. A coordinator counts an ack when Current is at least the
// version it sent.
type PutResult struct {
	Stored  bool
	Current ObjectMeta
}

// Hint is a write parked for a preferred node that was unreachable.
type Hint struct {
	Target string
	Meta   ObjectMeta
}

// Stats summarises local usage for the dashboard.
type Stats struct {
	Objects    int    `json:"objects"`
	Tombstones int    `json:"tombstones"`
	Bytes      uint64 `json:"bytes"`
	Hints      int    `json:"hints"`
	HintBytes  uint64 `json:"hint_bytes"`
}

// Disk is the filesystem + bbolt store. It is safe for concurrent use.
type Disk struct {
	dir string
	db  *bolt.DB

	locks [64]sync.Mutex

	tamperMu sync.Mutex
	tampered map[string]bool
}

// Open creates or opens the store rooted at dir.
func Open(dir string) (*Disk, error) {
	for _, sub := range []string{"blobs", "hints"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, fmt.Errorf("store: mkdir: %w", err)
		}
	}
	db, err := bolt.Open(filepath.Join(dir, "index.db"), 0o600, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("store: open index: %w", err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, b := range [][]byte{bucketObjects, bucketHints} {
			if _, err := tx.CreateBucketIfNotExists(b); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: init index: %w", err)
	}
	return &Disk{dir: dir, db: db, tampered: map[string]bool{}}, nil
}

// Close releases the index.
func (d *Disk) Close() error { return d.db.Close() }

// Dir is the store root.
func (d *Disk) Dir() string { return d.dir }

func (d *Disk) lock(key string) func() {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	m := &d.locks[h.Sum32()%uint32(len(d.locks))]
	m.Lock()
	return m.Unlock
}

// Put stores a primary replica when meta supersedes the local copy, or when
// meta is the same write and the local bytes are corrupt (that is a heal).
// The body must hash to meta.Checksum; a coordinator never gets to store
// bytes that are already wrong.
func (d *Disk) Put(meta ObjectMeta, body []byte) (PutResult, error) {
	if err := validate(meta, body); err != nil {
		return PutResult{}, err
	}
	meta.HintedFor = ""
	defer d.lock(meta.Key)()

	current, found, err := d.readMeta(bucketObjects, []byte(meta.Key))
	if err != nil {
		return PutResult{}, err
	}
	if found && AtLeast(current, meta) {
		// Keep what we have unless its bytes are bad. A corrupt copy is
		// replaced even by an older valid one: unreadable data helps no one,
		// and repair will push the newest valid version afterwards.
		if ok, _ := d.verifyFile(d.blobPath(current), current); ok {
			return PutResult{Current: current}, nil
		}
	}

	path := d.blobPath(meta)
	if !meta.Deleted {
		if err := writeFileAtomic(path, body); err != nil {
			return PutResult{}, err
		}
	}
	if err := d.writeMeta(bucketObjects, []byte(meta.Key), meta); err != nil {
		return PutResult{}, err
	}
	if found {
		if old := d.blobPath(current); old != path || meta.Deleted {
			_ = os.Remove(old)
		}
	}
	d.clearTampered(meta.Key)
	return PutResult{Stored: true, Current: meta}, nil
}

// Get returns the local primary replica and whether its bytes still verify.
func (d *Disk) Get(key string) (Object, error) {
	defer d.lock(key)()
	return d.readObject(bucketObjects, []byte(key), d.blobPath)
}

// Head returns the index entry without reading the payload.
func (d *Disk) Head(key string) (ObjectMeta, error) {
	meta, found, err := d.readMeta(bucketObjects, []byte(key))
	if err != nil {
		return ObjectMeta{}, err
	}
	if !found {
		return ObjectMeta{}, ErrNotFound
	}
	return meta, nil
}

// Verify re-hashes the local payload of key. It is what the scrubber calls.
func (d *Disk) Verify(key string) (bool, error) {
	defer d.lock(key)()
	meta, found, err := d.readMeta(bucketObjects, []byte(key))
	if err != nil {
		return false, err
	}
	if !found {
		return false, ErrNotFound
	}
	if meta.Deleted {
		return true, nil
	}
	return d.verifyFile(d.blobPath(meta), meta)
}

// Delete drops the local primary replica entirely. Rebalance calls it once
// the key's new owners hold the same or a newer version. Client deletes are
// tombstone writes through Put, not this.
func (d *Disk) Delete(key string) error {
	defer d.lock(key)()
	meta, found, err := d.readMeta(bucketObjects, []byte(key))
	if err != nil || !found {
		return err
	}
	err = d.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketObjects).Delete([]byte(key))
	})
	if err != nil {
		return fmt.Errorf("store: delete index: %w", err)
	}
	_ = os.Remove(d.blobPath(meta))
	d.clearTampered(key)
	return nil
}

// DeleteIf drops the local replica only if it is not newer than meta. It
// keeps rebalance from dropping a write that landed while it was copying.
func (d *Disk) DeleteIf(meta ObjectMeta) (bool, error) {
	current, err := d.Head(meta.Key)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if Newer(current, meta) {
		return false, nil
	}
	return true, d.Delete(meta.Key)
}

// List returns every primary index entry, sorted by key.
func (d *Disk) List() ([]ObjectMeta, error) {
	var out []ObjectMeta
	err := d.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketObjects).ForEach(func(_, v []byte) error {
			meta, err := decodeMeta(v)
			if err != nil {
				return err
			}
			out = append(out, meta)
			return nil
		})
	})
	return out, err
}

// Corrupt flips one byte of the local payload. It exists so the demo can
// prove that the scrubber and read path notice. Tombstones have no payload.
func (d *Disk) Corrupt(key string) error {
	defer d.lock(key)()
	meta, found, err := d.readMeta(bucketObjects, []byte(key))
	if err != nil {
		return err
	}
	if !found {
		return ErrNotFound
	}
	if meta.Deleted {
		return fmt.Errorf("store: %q is a tombstone; nothing to corrupt", key)
	}
	path := d.blobPath(meta)
	body, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("store: read for corrupt: %w", err)
	}
	if len(body) == 0 {
		body = []byte{0xff}
	} else {
		body[len(body)/2] ^= 0xff
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return fmt.Errorf("store: write corrupt: %w", err)
	}
	d.tamperMu.Lock()
	d.tampered[key] = true
	d.tamperMu.Unlock()
	return nil
}

// Tampered lists keys whose bytes were flipped by Corrupt and have not been
// rewritten since. The dashboard uses it to show a flip nobody caught yet.
func (d *Disk) Tampered() []string {
	d.tamperMu.Lock()
	defer d.tamperMu.Unlock()
	out := make([]string, 0, len(d.tampered))
	for k := range d.tampered {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (d *Disk) clearTampered(key string) {
	d.tamperMu.Lock()
	delete(d.tampered, key)
	d.tamperMu.Unlock()
}

// PutHint parks a write for target. The same last-writer-wins rule applies
// inside each target's queue.
func (d *Disk) PutHint(target string, meta ObjectMeta, body []byte) (PutResult, error) {
	if target == "" {
		return PutResult{}, errors.New("store: hint needs a target")
	}
	if err := validate(meta, body); err != nil {
		return PutResult{}, err
	}
	meta.HintedFor = target
	defer d.lock(meta.Key)()

	id := hintID(target, meta.Key)
	current, found, err := d.readMeta(bucketHints, id)
	if err != nil {
		return PutResult{}, err
	}
	if found && AtLeast(current, meta) {
		return PutResult{Current: current}, nil
	}
	path := d.hintPath(target, meta)
	if !meta.Deleted {
		if err := writeFileAtomic(path, body); err != nil {
			return PutResult{}, err
		}
	}
	if err := d.writeMeta(bucketHints, id, meta); err != nil {
		return PutResult{}, err
	}
	if found {
		_ = os.Remove(d.hintPath(target, current))
	}
	return PutResult{Stored: true, Current: meta}, nil
}

// GetHint returns the hint parked for target, verified like a replica.
func (d *Disk) GetHint(target, key string) (Object, error) {
	defer d.lock(key)()
	return d.readObject(bucketHints, hintID(target, key), func(m ObjectMeta) string {
		return d.hintPath(target, m)
	})
}

// FindHint returns the newest verified hint for key across all targets.
func (d *Disk) FindHint(key string) (Object, error) {
	hints, err := d.ListHints()
	if err != nil {
		return Object{}, err
	}
	var best *Object
	for _, h := range hints {
		if h.Meta.Key != key {
			continue
		}
		obj, err := d.GetHint(h.Target, key)
		if err != nil || obj.Corrupt {
			continue
		}
		if best == nil || Newer(obj.Meta, best.Meta) {
			o := obj
			best = &o
		}
	}
	if best == nil {
		return Object{}, ErrNotFound
	}
	return *best, nil
}

// ListHints returns every parked hint, grouped by target then key.
func (d *Disk) ListHints() ([]Hint, error) {
	var out []Hint
	err := d.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketHints).ForEach(func(_, v []byte) error {
			meta, err := decodeMeta(v)
			if err != nil {
				return err
			}
			out = append(out, Hint{Target: meta.HintedFor, Meta: meta})
			return nil
		})
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].Target != out[j].Target {
			return out[i].Target < out[j].Target
		}
		return out[i].Meta.Key < out[j].Meta.Key
	})
	return out, err
}

// DeleteHintIf drops the hint for target unless a newer one replaced it
// while the old one was being replayed.
func (d *Disk) DeleteHintIf(target string, meta ObjectMeta) error {
	defer d.lock(meta.Key)()
	id := hintID(target, meta.Key)
	current, found, err := d.readMeta(bucketHints, id)
	if err != nil || !found || Newer(current, meta) {
		return err
	}
	err = d.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketHints).Delete(id)
	})
	if err != nil {
		return fmt.Errorf("store: delete hint: %w", err)
	}
	_ = os.Remove(d.hintPath(target, current))
	return nil
}

// Stats counts local objects, tombstones, hints, and payload bytes.
func (d *Disk) Stats() (Stats, error) {
	var s Stats
	err := d.db.View(func(tx *bolt.Tx) error {
		err := tx.Bucket(bucketObjects).ForEach(func(_, v []byte) error {
			meta, err := decodeMeta(v)
			if err != nil {
				return err
			}
			if meta.Deleted {
				s.Tombstones++
			} else {
				s.Objects++
				s.Bytes += meta.Size
			}
			return nil
		})
		if err != nil {
			return err
		}
		return tx.Bucket(bucketHints).ForEach(func(_, v []byte) error {
			meta, err := decodeMeta(v)
			if err != nil {
				return err
			}
			s.Hints++
			s.HintBytes += meta.Size
			return nil
		})
	})
	return s, err
}

func validate(meta ObjectMeta, body []byte) error {
	if meta.Key == "" {
		return errors.New("store: empty key")
	}
	if meta.Version == 0 {
		return errors.New("store: version 0 is reserved")
	}
	if meta.Deleted {
		if len(body) != 0 {
			return errors.New("store: tombstone with a body")
		}
		return nil
	}
	if uint64(len(body)) != meta.Size {
		return fmt.Errorf("store: body is %d bytes, meta says %d", len(body), meta.Size)
	}
	if Checksum(body) != meta.Checksum {
		return errors.New("store: body does not match checksum")
	}
	return nil
}

func (d *Disk) readObject(bucket, id []byte, pathOf func(ObjectMeta) string) (Object, error) {
	meta, found, err := d.readMeta(bucket, id)
	if err != nil {
		return Object{}, err
	}
	if !found {
		return Object{}, ErrNotFound
	}
	if meta.Deleted {
		return Object{Meta: meta}, nil
	}
	body, err := os.ReadFile(pathOf(meta))
	if errors.Is(err, os.ErrNotExist) {
		return Object{Meta: meta, Corrupt: true}, nil
	}
	if err != nil {
		return Object{}, fmt.Errorf("store: read payload: %w", err)
	}
	corrupt := uint64(len(body)) != meta.Size || Checksum(body) != meta.Checksum
	return Object{Meta: meta, Body: body, Corrupt: corrupt}, nil
}

func (d *Disk) verifyFile(path string, meta ObjectMeta) (bool, error) {
	if meta.Deleted {
		return true, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return false, err
	}
	return uint64(n) == meta.Size && bytes.Equal(h.Sum(nil), meta.Checksum[:]), nil
}

func (d *Disk) readMeta(bucket, id []byte) (ObjectMeta, bool, error) {
	var (
		meta  ObjectMeta
		found bool
	)
	err := d.db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket(bucket).Get(id)
		if v == nil {
			return nil
		}
		m, err := decodeMeta(v)
		if err != nil {
			return err
		}
		meta, found = m, true
		return nil
	})
	return meta, found, err
}

func (d *Disk) writeMeta(bucket, id []byte, meta ObjectMeta) error {
	raw, err := encodeMeta(meta)
	if err != nil {
		return err
	}
	err = d.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucket).Put(id, raw)
	})
	if err != nil {
		return fmt.Errorf("store: write index: %w", err)
	}
	return nil
}

func keyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func (d *Disk) blobPath(meta ObjectMeta) string {
	h := keyHash(meta.Key)
	return filepath.Join(d.dir, "blobs", h[:2], h+"."+strconv.FormatUint(meta.Version, 16))
}

func (d *Disk) hintPath(target string, meta ObjectMeta) string {
	h := keyHash(meta.Key)
	return filepath.Join(d.dir, "hints", url.PathEscape(target), h[:2], h+"."+strconv.FormatUint(meta.Version, 16))
}

func hintID(target, key string) []byte {
	return []byte(target + "\x00" + key)
}

func writeFileAtomic(path string, body []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("store: mkdir: %w", err)
	}
	f, err := os.CreateTemp(dir, ".incoming-*")
	if err != nil {
		return fmt.Errorf("store: temp file: %w", err)
	}
	tmp := f.Name()
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(body); err != nil {
		f.Close()
		cleanup()
		return fmt.Errorf("store: write payload: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		cleanup()
		return fmt.Errorf("store: fsync payload: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("store: close payload: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return fmt.Errorf("store: rename payload: %w", err)
	}
	return nil
}

// diskMeta is the JSON shape in index.db. The checksum is hex so the index
// is readable with bbolt's CLI when debugging.
type diskMeta struct {
	Key         string `json:"key"`
	Version     uint64 `json:"version"`
	Checksum    string `json:"checksum"`
	Size        uint64 `json:"size"`
	Origin      string `json:"origin"`
	HintedFor   string `json:"hinted_for,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
	WrittenAtMs int64  `json:"written_at_ms"`
	ContentType string `json:"content_type,omitempty"`
}

func encodeMeta(m ObjectMeta) ([]byte, error) {
	var written int64
	if !m.WrittenAt.IsZero() {
		written = m.WrittenAt.UnixMilli()
	}
	return json.Marshal(diskMeta{
		Key:         m.Key,
		Version:     m.Version,
		Checksum:    m.ChecksumHex(),
		Size:        m.Size,
		Origin:      m.Origin,
		HintedFor:   m.HintedFor,
		Deleted:     m.Deleted,
		WrittenAtMs: written,
		ContentType: m.ContentType,
	})
}

func decodeMeta(raw []byte) (ObjectMeta, error) {
	var dm diskMeta
	if err := json.Unmarshal(raw, &dm); err != nil {
		return ObjectMeta{}, fmt.Errorf("store: decode index: %w", err)
	}
	m := ObjectMeta{
		Key:         dm.Key,
		Version:     dm.Version,
		Size:        dm.Size,
		Origin:      dm.Origin,
		HintedFor:   dm.HintedFor,
		Deleted:     dm.Deleted,
		ContentType: dm.ContentType,
	}
	if dm.WrittenAtMs != 0 {
		m.WrittenAt = time.UnixMilli(dm.WrittenAtMs).UTC()
	}
	sum, err := hex.DecodeString(dm.Checksum)
	if err != nil || len(sum) != len(m.Checksum) {
		return ObjectMeta{}, fmt.Errorf("store: bad checksum in index for %q", dm.Key)
	}
	copy(m.Checksum[:], sum)
	return m, nil
}
