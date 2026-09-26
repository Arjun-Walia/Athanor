package store

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	bolt "go.etcd.io/bbolt"
)

func open(t *testing.T) *Disk {
	t.Helper()
	d, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

func metaFor(key string, version uint64, origin string, body []byte) ObjectMeta {
	return ObjectMeta{
		Key:      key,
		Version:  version,
		Checksum: Checksum(body),
		Size:     uint64(len(body)),
		Origin:   origin,
	}
}

func TestPutGetRoundTrip(t *testing.T) {
	d := open(t)
	body := []byte("quarterly report")
	res, err := d.Put(metaFor("reports/q3.pdf", 1, "node1", body), body)
	if err != nil || !res.Stored {
		t.Fatalf("put = %+v, %v", res, err)
	}
	obj, err := d.Get("reports/q3.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if obj.Corrupt || !bytes.Equal(obj.Body, body) {
		t.Fatalf("get = %+v", obj)
	}
	if _, err := d.Get("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing err = %v", err)
	}
}

func TestPutRejectsBadChecksum(t *testing.T) {
	d := open(t)
	meta := metaFor("k", 1, "node1", []byte("right"))
	if _, err := d.Put(meta, []byte("wrong")); err == nil {
		t.Fatal("expected checksum rejection")
	}
}

func TestLastWriterWins(t *testing.T) {
	d := open(t)
	v2 := []byte("v2")
	v1 := []byte("v1")
	if _, err := d.Put(metaFor("k", 2, "node1", v2), v2); err != nil {
		t.Fatal(err)
	}
	res, err := d.Put(metaFor("k", 1, "node9", v1), v1)
	if err != nil {
		t.Fatal(err)
	}
	if res.Stored || res.Current.Version != 2 {
		t.Fatalf("older write stored: %+v", res)
	}
	// Equal versions break the tie on origin.
	tie := []byte("tie")
	res, err = d.Put(metaFor("k", 2, "node2", tie), tie)
	if err != nil || !res.Stored {
		t.Fatalf("tie-break = %+v, %v", res, err)
	}
	obj, _ := d.Get("k")
	if !bytes.Equal(obj.Body, tie) {
		t.Fatalf("body = %q", obj.Body)
	}
}

func TestCorruptIsDetectedAndHealedBySameVersion(t *testing.T) {
	d := open(t)
	body := []byte("the only copy that matters")
	meta := metaFor("k", 7, "node1", body)
	if _, err := d.Put(meta, body); err != nil {
		t.Fatal(err)
	}
	if err := d.Corrupt("k"); err != nil {
		t.Fatal(err)
	}
	if ok, _ := d.Verify("k"); ok {
		t.Fatal("verify passed on corrupt bytes")
	}
	if obj, _ := d.Get("k"); !obj.Corrupt {
		t.Fatal("get did not flag corruption")
	}
	if got := d.Tampered(); len(got) != 1 || got[0] != "k" {
		t.Fatalf("tampered = %v", got)
	}
	// Re-sending the same version is a no-op normally, but heals bad bytes.
	res, err := d.Put(meta, body)
	if err != nil || !res.Stored {
		t.Fatalf("heal = %+v, %v", res, err)
	}
	if ok, _ := d.Verify("k"); !ok {
		t.Fatal("still corrupt after heal")
	}
	if len(d.Tampered()) != 0 {
		t.Fatal("tampered flag survived a heal")
	}
	res, _ = d.Put(meta, body)
	if res.Stored {
		t.Fatal("healthy same-version write should be a no-op")
	}
}

func TestTombstone(t *testing.T) {
	d := open(t)
	body := []byte("x")
	if _, err := d.Put(metaFor("k", 1, "node1", body), body); err != nil {
		t.Fatal(err)
	}
	tomb := metaFor("k", 2, "node1", nil)
	tomb.Deleted = true
	if _, err := d.Put(tomb, nil); err != nil {
		t.Fatal(err)
	}
	obj, err := d.Get("k")
	if err != nil || !obj.Meta.Deleted || obj.Corrupt {
		t.Fatalf("tombstone get = %+v, %v", obj, err)
	}
	stats, _ := d.Stats()
	if stats.Objects != 0 || stats.Tombstones != 1 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestHintsQueue(t *testing.T) {
	d := open(t)
	body := []byte("parked")
	meta := metaFor("k", 3, "node1", body)
	if _, err := d.PutHint("node2", meta, body); err != nil {
		t.Fatal(err)
	}
	hints, err := d.ListHints()
	if err != nil || len(hints) != 1 || hints[0].Target != "node2" {
		t.Fatalf("hints = %+v, %v", hints, err)
	}
	obj, err := d.FindHint("k")
	if err != nil || !bytes.Equal(obj.Body, body) || obj.Meta.HintedFor != "node2" {
		t.Fatalf("find hint = %+v, %v", obj, err)
	}
	// A newer hint must survive deletion of the older one it replaced.
	newer := []byte("newer")
	if _, err := d.PutHint("node2", metaFor("k", 4, "node1", newer), newer); err != nil {
		t.Fatal(err)
	}
	if err := d.DeleteHintIf("node2", meta); err != nil {
		t.Fatal(err)
	}
	if hints, _ := d.ListHints(); len(hints) != 1 {
		t.Fatalf("newer hint was dropped: %+v", hints)
	}
	if err := d.DeleteHintIf("node2", metaFor("k", 4, "node1", newer)); err != nil {
		t.Fatal(err)
	}
	if hints, _ := d.ListHints(); len(hints) != 0 {
		t.Fatalf("hint not dropped: %+v", hints)
	}
}

func TestDeleteIfKeepsNewer(t *testing.T) {
	d := open(t)
	body := []byte("b")
	old := metaFor("k", 1, "node1", body)
	cur := metaFor("k", 2, "node1", body)
	if _, err := d.Put(cur, body); err != nil {
		t.Fatal(err)
	}
	dropped, err := d.DeleteIf(old)
	if err != nil || dropped {
		t.Fatalf("dropped newer copy: %v %v", dropped, err)
	}
	dropped, err = d.DeleteIf(cur)
	if err != nil || !dropped {
		t.Fatalf("drop = %v %v", dropped, err)
	}
	if _, err := d.Head("k"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("head after drop = %v", err)
	}
}

func TestReopenKeepsIndex(t *testing.T) {
	dir := t.TempDir()
	d, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("durable")
	if _, err := d.Put(metaFor("k", 1, "node1", body), body); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	d, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	obj, err := d.Get("k")
	if err != nil || !bytes.Equal(obj.Body, body) {
		t.Fatalf("after reopen = %+v, %v", obj, err)
	}
}

func TestSweepRemovesOrphansAndKeepsLiveFiles(t *testing.T) {
	dir := t.TempDir()
	d, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte("keep me")
	meta := metaFor("k", 1, "node1", body)
	if _, err := d.Put(meta, body); err != nil {
		t.Fatal(err)
	}
	live := d.blobPath(meta)
	old := time.Now().Add(-time.Minute)

	// A temp file from a crash mid-write and a superseded payload nobody
	// references any more. Both are older than the sweep's grace window.
	orphanTmp := filepath.Join(filepath.Dir(live), ".incoming-crash")
	orphanOld := filepath.Join(filepath.Dir(live), "deadbeef.1")
	for _, p := range []string{orphanTmp, orphanOld} {
		if err := os.WriteFile(p, []byte("junk"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, old, old); err != nil {
			t.Fatal(err)
		}
	}
	_ = d.Close()

	d, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	for _, p := range []string{orphanTmp, orphanOld} {
		if _, err := os.Stat(p); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("orphan %s survived the sweep", p)
		}
	}
	if _, err := os.Stat(live); err != nil {
		t.Fatalf("live payload removed: %v", err)
	}
	stats, _ := d.Stats()
	if stats.Swept != 2 {
		t.Fatalf("swept = %d, want 2", stats.Swept)
	}
	obj, err := d.Get("k")
	if err != nil || obj.Corrupt || !bytes.Equal(obj.Body, body) {
		t.Fatalf("after sweep = %+v, %v", obj, err)
	}
}

func TestListSkipsDamagedIndexRecord(t *testing.T) {
	d := open(t)
	body := []byte("fine")
	if _, err := d.Put(metaFor("good", 1, "node1", body), body); err != nil {
		t.Fatal(err)
	}
	err := d.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketObjects).Put([]byte("broken"), []byte("{not json"))
	})
	if err != nil {
		t.Fatal(err)
	}
	list, err := d.List()
	if err != nil {
		t.Fatalf("list with a damaged record failed: %v", err)
	}
	if len(list) != 1 || list[0].Key != "good" {
		t.Fatalf("list = %+v", list)
	}
	stats, _ := d.Stats()
	if stats.IndexErrors != 1 {
		t.Fatalf("index errors = %d, want 1", stats.IndexErrors)
	}
}

func TestMetaRoundTripAndMaxVersion(t *testing.T) {
	d := open(t)
	if _, ok, _ := d.GetMeta("policy"); ok {
		t.Fatal("meta present before any write")
	}
	if err := d.PutMeta("policy", []byte(`{"n":3}`)); err != nil {
		t.Fatal(err)
	}
	raw, ok, err := d.GetMeta("policy")
	if err != nil || !ok || string(raw) != `{"n":3}` {
		t.Fatalf("meta = %q %v %v", raw, ok, err)
	}
	body := []byte("x")
	if _, err := d.Put(metaFor("a", 40, "node1", body), body); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PutHint("node2", metaFor("b", 900, "node1", body), body); err != nil {
		t.Fatal(err)
	}
	if v, err := d.MaxVersion(); err != nil || v != 900 {
		t.Fatalf("max version = %d, %v", v, err)
	}
}

func TestVerifyHintsDropsCorruptOnes(t *testing.T) {
	d := open(t)
	body := []byte("parked bytes")
	meta := metaFor("k", 3, "node1", body)
	if _, err := d.PutHint("node2", meta, body); err != nil {
		t.Fatal(err)
	}
	checked, dropped, err := d.VerifyHints()
	if err != nil || checked != 1 || dropped != 0 {
		t.Fatalf("healthy hint: %d %d %v", checked, dropped, err)
	}
	if err := os.WriteFile(d.hintPath("node2", meta), []byte("parked byteZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	checked, dropped, err = d.VerifyHints()
	if err != nil || checked != 1 || dropped != 1 {
		t.Fatalf("corrupt hint: %d %d %v", checked, dropped, err)
	}
	if hints, _ := d.ListHints(); len(hints) != 0 {
		t.Fatalf("corrupt hint kept: %+v", hints)
	}
}

func TestHintCountTracksTheQueue(t *testing.T) {
	dir := t.TempDir()
	d, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if d.HintCount() != 0 {
		t.Fatal("fresh store has hints")
	}
	if _, err := d.FindHint("k"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("find on an empty queue = %v", err)
	}
	body := []byte("parked")
	meta := metaFor("k", 1, "node1", body)
	if _, err := d.PutHint("node2", meta, body); err != nil {
		t.Fatal(err)
	}
	if _, err := d.PutHint("node2", meta, body); err != nil { // same write again: no new entry
		t.Fatal(err)
	}
	if _, err := d.PutHint("node3", meta, body); err != nil {
		t.Fatal(err)
	}
	if d.HintCount() != 2 {
		t.Fatalf("count = %d, want 2", d.HintCount())
	}
	_ = d.Close()
	d, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	if d.HintCount() != 2 {
		t.Fatalf("count after reopen = %d, want 2", d.HintCount())
	}
	if err := d.DeleteHintIf("node2", meta); err != nil {
		t.Fatal(err)
	}
	if d.HintCount() != 1 {
		t.Fatalf("count after delete = %d, want 1", d.HintCount())
	}
	if obj, err := d.FindHint("k"); err != nil || obj.Meta.HintedFor != "node3" {
		t.Fatalf("find = %+v, %v", obj, err)
	}
}

func TestCorruptRefusesTombstonesAndUnknownKeys(t *testing.T) {
	d := open(t)
	if err := d.Corrupt("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("corrupt missing = %v", err)
	}
	tomb := metaFor("k", 1, "node1", nil)
	tomb.Deleted = true
	if _, err := d.Put(tomb, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.Corrupt("k"); err == nil {
		t.Fatal("a tombstone has no bytes to flip")
	}
	if _, err := d.GetHint("node2", "k"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get hint = %v", err)
	}
}

func FuzzDecodeMetaNeverPanics(f *testing.F) {
	body := []byte("seed")
	raw, _ := encodeMeta(metaFor("k", 9, "node1", body))
	f.Add(raw)
	f.Add([]byte(`{"key":"k","version":1,"checksum":"zz"}`))
	f.Add([]byte(`{`))
	f.Fuzz(func(t *testing.T, data []byte) {
		m, err := decodeMeta(data)
		if err == nil && m.Key == "" {
			t.Fatalf("decoded a record with no key from %q", data)
		}
	})
}

func BenchmarkPutGet(b *testing.B) {
	d, err := Open(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	body := bytes.Repeat([]byte("x"), 4096)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		meta := metaFor("bench", uint64(i+1), "node1", body)
		if _, err := d.Put(meta, body); err != nil {
			b.Fatal(err)
		}
		if _, err := d.Get("bench"); err != nil {
			b.Fatal(err)
		}
	}
}
