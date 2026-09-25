package replica

import "testing"

func TestDefaultQuorum(t *testing.T) {
	q := DefaultQuorum()
	if q.N != 3 || q.W != 2 || q.R != 2 {
		t.Fatalf("default quorum = %+v, want 3/2/2", q)
	}
	if !q.Valid() {
		t.Fatal("default quorum should be valid")
	}
}

func TestQuorumOverlapAndTolerance(t *testing.T) {
	q := DefaultQuorum()
	if !q.Overlapping() {
		t.Fatal("3/2/2 must overlap")
	}
	if (Quorum{N: 3, W: 1, R: 1}).Overlapping() {
		t.Fatal("3/1/1 must not overlap")
	}
	if q.WriteTolerance() != 1 || q.ReadTolerance() != 1 {
		t.Fatalf("tolerance = %d/%d, want 1/1", q.WriteTolerance(), q.ReadTolerance())
	}
	if err := (Quorum{N: MaxN + 1, W: 1, R: 1}).Validate(); err == nil {
		t.Fatal("N above MaxN accepted")
	}
}

func TestQuorumValid(t *testing.T) {
	tests := []struct {
		name  string
		q     Quorum
		valid bool
	}{
		{name: "weak but well formed", q: Quorum{N: 3, W: 1, R: 1}, valid: true},
		{name: "zero n", q: Quorum{N: 0, W: 1, R: 1}, valid: false},
		{name: "w above n", q: Quorum{N: 3, W: 4, R: 2}, valid: false},
		{name: "r above n", q: Quorum{N: 3, W: 2, R: 4}, valid: false},
		{name: "zero w", q: Quorum{N: 3, W: 0, R: 2}, valid: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.q.Valid(); got != tt.valid {
				t.Fatalf("Valid() = %v, want %v", got, tt.valid)
			}
		})
	}
}
