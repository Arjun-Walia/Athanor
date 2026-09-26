package ring

import (
	"fmt"
	"testing"
)

var five = []string{"node1", "node2", "node3", "node4", "node5"}

func TestPreferenceIsDistinctAndDeterministic(t *testing.T) {
	a := New(five, DefaultVNodes, 1)
	b := New([]string{"node5", "node3", "node1", "node4", "node2"}, DefaultVNodes, 9)
	for i := 0; i < 500; i++ {
		key := fmt.Sprintf("obj-%d", i)
		pa, err := a.Preference(key, 3)
		if err != nil {
			t.Fatal(err)
		}
		pb, _ := b.Preference(key, 3)
		if fmt.Sprint(pa.Nodes) != fmt.Sprint(pb.Nodes) {
			t.Fatalf("%s: order-dependent placement %v vs %v", key, pa.Nodes, pb.Nodes)
		}
		seen := map[string]bool{}
		for _, n := range pa.Nodes {
			if seen[n] {
				t.Fatalf("%s: duplicate owner in %v", key, pa.Nodes)
			}
			seen[n] = true
		}
		if len(pa.Nodes) != 3 {
			t.Fatalf("%s: got %d owners", key, len(pa.Nodes))
		}
	}
	if a.Digest() != b.Digest() {
		t.Fatal("same member set, different digest")
	}
}

func TestPreferenceCapsAtRingSize(t *testing.T) {
	r := New([]string{"node1", "node2"}, 8, 1)
	p, err := r.Preference("k", 3)
	if err != nil || len(p.Nodes) != 2 {
		t.Fatalf("pref = %+v, %v", p, err)
	}
	if _, err := New(nil, 8, 1).Preference("k", 3); err != ErrEmpty {
		t.Fatalf("empty ring err = %v", err)
	}
}

func TestLoadIsRoughlyBalanced(t *testing.T) {
	r := New(five, DefaultVNodes, 1)
	counts := map[string]int{}
	const keys = 20000
	for i := 0; i < keys; i++ {
		p, _ := r.Preference(fmt.Sprintf("k%d", i), 1)
		counts[p.Nodes[0]]++
	}
	for node, c := range counts {
		share := float64(c) / keys
		if share < 0.12 || share > 0.28 {
			t.Fatalf("%s owns %.1f%% of keys; vnodes should keep it near 20%%", node, share*100)
		}
	}
}

func TestJoinMovesAMinorityOfKeys(t *testing.T) {
	before := New(five, DefaultVNodes, 1)
	after := New(append(append([]string{}, five...), "node6"), DefaultVNodes, 2)
	moved := 0
	const keys = 10000
	for i := 0; i < keys; i++ {
		key := fmt.Sprintf("k%d", i)
		a, _ := before.Preference(key, 1)
		b, _ := after.Preference(key, 1)
		if a.Nodes[0] != b.Nodes[0] {
			if b.Nodes[0] != "node6" {
				t.Fatalf("%s moved between old nodes %s -> %s", key, a.Nodes[0], b.Nodes[0])
			}
			moved++
		}
	}
	if share := float64(moved) / keys; share > 0.3 {
		t.Fatalf("join moved %.1f%% of primaries; expected about 1/6", share*100)
	}
}

func TestWalkStartsWithPreference(t *testing.T) {
	r := New(five, DefaultVNodes, 1)
	walk := r.Walk("report.pdf")
	pref, _ := r.Preference("report.pdf", 3)
	if len(walk) != 5 || fmt.Sprint(walk[:3]) != fmt.Sprint(pref.Nodes) {
		t.Fatalf("walk %v, pref %v", walk, pref.Nodes)
	}
}

func TestPositionAndOwners(t *testing.T) {
	r := New(five, DefaultVNodes, 1)
	if p := Position(KeyHash("report.pdf")); p < 0 || p >= 1 {
		t.Fatalf("position out of range: %v", p)
	}
	if Position(0) != 0 {
		t.Fatal("hash 0 should sit at the top of the ring")
	}
	pref, _ := r.Preference("report.pdf", 3)
	if fmt.Sprint(r.Owners("report.pdf", 3)) != fmt.Sprint(pref.Nodes) {
		t.Fatalf("owners %v, pref %v", r.Owners("report.pdf", 3), pref.Nodes)
	}
	if New(nil, 8, 1).Owners("k", 3) != nil {
		t.Fatal("owners on an empty ring should be nil")
	}
}

func FuzzWalkIsAPermutationOfMembers(f *testing.F) {
	f.Add("report.pdf")
	f.Add("")
	f.Add("a/b/c")
	f.Fuzz(func(t *testing.T, key string) {
		r := New(five, 16, 1)
		walk := r.Walk(key)
		if len(walk) != len(five) {
			t.Fatalf("walk of %q has %d nodes", key, len(walk))
		}
		seen := map[string]bool{}
		for _, n := range walk {
			if seen[n] {
				t.Fatalf("walk of %q repeats %s", key, n)
			}
			seen[n] = true
		}
	})
}

func BenchmarkWalk(b *testing.B) {
	r := New(five, DefaultVNodes, 1)
	keys := make([]string, 1024)
	for i := range keys {
		keys[i] = fmt.Sprintf("obj-%d", i)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.Walk(keys[i%len(keys)])
	}
}
