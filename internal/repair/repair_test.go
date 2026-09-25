package repair_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/repair"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/replica/replicatest"
	"github.com/Arjun-Walia/Athanor/internal/ring"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

var names = []string{"node1", "node2", "node3", "node4", "node5"}

func put(t *testing.T, c *replicatest.Cluster, key, body string) []string {
	t.Helper()
	co := replica.NewCoordinator(c.View("node1"), &replica.Clock{}, events.New("node1", 50, true), time.Second)
	if _, err := co.Put(context.Background(), key, []byte(body), ""); err != nil {
		t.Fatal(err)
	}
	pref, _ := replica.Preference(c.View("node1"), key, 3)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		n := 0
		for _, p := range pref {
			if _, err := c.Stores[p].Head(key); err == nil {
				n++
			}
		}
		if n == len(pref) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return pref
}

func TestRepairHealsCorruptReplicaFromHealthyOne(t *testing.T) {
	c := replicatest.New(t, names)
	pref := put(t, c, "report.pdf", "the real bytes")
	victim := pref[2]
	if err := c.Stores[victim].Corrupt("report.pdf"); err != nil {
		t.Fatal(err)
	}
	log := events.New("node1", 50, true)
	r := repair.NewRepairer(c.View("node1"), log, time.Second)
	rep, err := r.Repair(context.Background(), "report.pdf", repair.ReasonScrub)
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Corrupt) != 1 || rep.Corrupt[0] != victim || len(rep.Pushed) != 1 {
		t.Fatalf("report = %+v", rep)
	}
	if ok, _ := c.Stores[victim].Verify("report.pdf"); !ok {
		t.Fatal("victim still corrupt")
	}
	if ev, ok := log.Last(events.KindRepair); !ok || ev.Level != events.LevelOK {
		t.Fatalf("repair event = %+v", ev)
	}
}

func TestScrubFindsAndHealsLocalCorruption(t *testing.T) {
	c := replicatest.New(t, names)
	pref := put(t, c, "k", "payload")
	self := pref[0]
	if err := c.Stores[self].Corrupt("k"); err != nil {
		t.Fatal(err)
	}
	log := events.New(self, 50, true)
	r := repair.NewRepairer(c.View(self), log, time.Second)
	s := repair.NewScrubber(c.Stores[self], r.Repair, log, time.Hour)
	checked, mismatches, err := s.ScrubOnce(context.Background(), true)
	if err != nil || checked != 1 || mismatches != 1 {
		t.Fatalf("scrub = %d checked, %d mismatches, %v", checked, mismatches, err)
	}
	obj, _ := c.Stores[self].Get("k")
	if obj.Corrupt || !bytes.Equal(obj.Body, []byte("payload")) {
		t.Fatalf("after scrub = %+v", obj)
	}
}

func TestHintReplayDeliversWhenTargetReturns(t *testing.T) {
	c := replicatest.New(t, names)
	pref, fallbacks := replica.Preference(c.View("node1"), "k", 3)
	dead := pref[1]
	c.SetDown(dead, true)
	co := replica.NewCoordinator(c.View(pref[0]), &replica.Clock{}, events.New(pref[0], 50, true), time.Second)
	if _, err := co.Put(context.Background(), "k", []byte("while you were out"), ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	holder := fallbacks[0]
	log := events.New(holder, 50, true)
	r := repair.NewRepairer(c.View(holder), log, time.Second)
	h := repair.NewHintReplayer(c.Stores[holder], c.View(holder), r.Repair, log)

	if n := h.ReplayOnce(context.Background()); n != 0 {
		t.Fatalf("replayed %d hints to a dead node", n)
	}
	c.SetDown(dead, false)
	if n := h.ReplayOnce(context.Background()); n != 1 {
		t.Fatalf("replayed %d, want 1", n)
	}
	obj, err := c.Stores[dead].Get("k")
	if err != nil || string(obj.Body) != "while you were out" {
		t.Fatalf("returned node has %+v, %v", obj, err)
	}
	if hints, _ := c.Stores[holder].ListHints(); len(hints) != 0 {
		t.Fatalf("hint not retired: %+v", hints)
	}
}

func TestRebalanceMovesKeysToNewOwnerAndDropsExtras(t *testing.T) {
	c := replicatest.New(t, names)
	keys := []string{}
	for i := 0; i < 40; i++ {
		k := "obj-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		keys = append(keys, k)
		put(t, c, k, "v-"+k)
	}

	// A sixth node joins: new ring, empty store.
	d, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	c.Stores["node6"] = d
	all := append(append([]string{}, names...), "node6")
	c.Ring = ring.New(all, 16, 2)

	for _, n := range all {
		b := repair.NewRebalancer(c.Stores[n], c.View(n), events.New(n, 200, true), 1000)
		b.RunOnce(context.Background(), "test join")
	}

	gotNew := 0
	for _, k := range keys {
		pref, _ := replica.Preference(c.View("node1"), k, 3)
		for _, n := range all {
			_, err := c.Stores[n].Head(k)
			has := err == nil
			owner := false
			for _, p := range pref {
				owner = owner || p == n
			}
			if owner && !has {
				t.Fatalf("%s: owner %s missing (pref %v)", k, n, pref)
			}
			if !owner && has {
				t.Fatalf("%s: non-owner %s kept a copy (pref %v)", k, n, pref)
			}
			if n == "node6" && has {
				gotNew++
			}
		}
	}
	if gotNew == 0 {
		t.Fatal("node6 received no keys")
	}
}

func TestTokenBucketLimitsRate(t *testing.T) {
	tb := repair.NewTokenBucket(50, 1)
	start := time.Now()
	for i := 0; i < 6; i++ {
		if err := tb.Wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if el := time.Since(start); el < 80*time.Millisecond {
		t.Fatalf("6 tokens at 50/s took %s", el)
	}
}
