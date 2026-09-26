package node

import (
	"context"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func TestAuthInterceptorRequiresTheClusterSecret(t *testing.T) {
	ok := func(ctx context.Context, req any) (any, error) { return "served", nil }
	info := &grpc.UnaryServerInfo{FullMethod: "/athanor.v1.Node/Replicate"}

	open := authInterceptor("")
	if out, err := open(context.Background(), nil, info, ok); err != nil || out != "served" {
		t.Fatalf("no secret configured should pass: %v %v", out, err)
	}

	guarded := authInterceptor("hunter2")
	if _, err := guarded(context.Background(), nil, info, ok); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("missing secret = %v, want Unauthenticated", err)
	}
	wrong := metadata.NewIncomingContext(context.Background(), metadata.Pairs(secretHeader, "hunter3"))
	if _, err := guarded(wrong, nil, info, ok); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("wrong secret = %v, want Unauthenticated", err)
	}
	right := metadata.NewIncomingContext(context.Background(), metadata.Pairs(secretHeader, "hunter2"))
	if out, err := guarded(right, nil, info, ok); err != nil || out != "served" {
		t.Fatalf("right secret = %v %v", out, err)
	}
}

func TestMemoCachesWithinTTLAndInvalidates(t *testing.T) {
	var m memo[int]
	calls := 0
	fn := func() (int, error) {
		calls++
		return calls, nil
	}
	if v, _ := m.get(time.Hour, fn); v != 1 {
		t.Fatalf("first = %d", v)
	}
	if v, _ := m.get(time.Hour, fn); v != 1 || calls != 1 {
		t.Fatalf("cached = %d, calls %d", v, calls)
	}
	m.invalidate()
	if v, _ := m.get(time.Hour, fn); v != 2 {
		t.Fatalf("after invalidate = %d", v)
	}
	if v, _ := m.get(0, fn); v != 3 {
		t.Fatalf("zero ttl must recompute: %d", v)
	}
}
