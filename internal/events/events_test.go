package events

import "testing"

func TestRingKeepsNewestAndCounts(t *testing.T) {
	l := New("node1", 3, true)
	for i := 0; i < 5; i++ {
		l.Emitf(KindWrite, LevelOK, "k", "write %d", i)
	}
	got := l.Since(0, 0)
	if len(got) != 3 || got[0].Message != "write 2" || got[2].Message != "write 4" {
		t.Fatalf("since(0) = %+v", got)
	}
	if s := l.Stats(); s.Total != 5 || s.Retained != 3 || s.Capacity != 3 {
		t.Fatalf("stats = %+v", s)
	}
	if got := l.Since(4, 0); len(got) != 1 || got[0].Seq != 5 {
		t.Fatalf("since(4) = %+v", got)
	}
	if got := l.Since(0, 1); len(got) != 1 || got[0].Seq != 5 {
		t.Fatalf("limit keeps the newest: %+v", got)
	}
}

func TestLastByKind(t *testing.T) {
	l := New("node1", 10, true)
	l.Emitf(KindScrub, LevelOK, "", "pass")
	l.Emitf(KindRepair, LevelWarn, "k", "first")
	l.Emitf(KindRepair, LevelOK, "k", "second")
	ev, ok := l.Last(KindRepair)
	if !ok || ev.Message != "second" || ev.Node != "node1" {
		t.Fatalf("last repair = %+v %v", ev, ok)
	}
	if _, ok := l.Last(KindFault); ok {
		t.Fatal("found a fault event that was never emitted")
	}
	if s := l.Stats(); s.Retained != 3 || s.Total != 3 {
		t.Fatalf("stats before wrap = %+v", s)
	}
}
