package store

import (
	"bytes"
	"errors"
	"testing"
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
	defer d.Close()
	obj, err := d.Get("k")
	if err != nil || !bytes.Equal(obj.Body, body) {
		t.Fatalf("after reopen = %+v, %v", obj, err)
	}
}
