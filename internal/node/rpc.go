package node

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/Arjun-Walia/Athanor/internal/api/nodepb"
	"github.com/Arjun-Walia/Athanor/internal/events"
	"github.com/Arjun-Walia/Athanor/internal/repair"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/store"
)

// maxMessage bounds one peer RPC. Client uploads are capped below this.
const maxMessage = 96 << 20

const (
	fromHeader   = "athanor-from"
	secretHeader = "athanor-secret"
)

// Keepalive settings. A peer that vanishes without closing its sockets (a
// pulled cable, a frozen VM) would otherwise leave a half-open connection
// that every call has to time out on. Pings every 10s with a 3s answer
// window mean such a peer is noticed inside one probe interval of SWIM's
// own verdict, and the gRPC client backs off and redials.
var (
	serverKeepalive = keepalive.ServerParameters{
		Time:    10 * time.Second,
		Timeout: 3 * time.Second,
	}
	serverKeepalivePolicy = keepalive.EnforcementPolicy{
		MinTime:             5 * time.Second,
		PermitWithoutStream: true,
	}
	clientKeepalive = keepalive.ClientParameters{
		Time:                10 * time.Second,
		Timeout:             3 * time.Second,
		PermitWithoutStream: true,
	}
)

func newGRPCServer(n *Node) *grpc.Server {
	srv := grpc.NewServer(
		grpc.MaxRecvMsgSize(maxMessage),
		grpc.MaxSendMsgSize(maxMessage),
		grpc.KeepaliveParams(serverKeepalive),
		grpc.KeepaliveEnforcementPolicy(serverKeepalivePolicy),
		grpc.ChainUnaryInterceptor(recoverInterceptor(n), authInterceptor(n.cfg.ClusterSecret), partitionInterceptor(n)),
	)
	nodepb.RegisterNodeServer(srv, &rpcServer{n: n})
	return srv
}

// recoverInterceptor turns a panic in one RPC into an Internal error for
// that caller. Without it a single bad request would take the whole node
// process down, and the node would then need a human to bring it back.
func recoverInterceptor(n *Node) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if r := recover(); r != nil {
				n.log.Emitf(events.KindFault, events.LevelErr, "", "%s recovered from a panic in %s: %v", n.cfg.ID, info.FullMethod, r)
				err = status.Errorf(codes.Internal, "panic in %s: %v", info.FullMethod, r)
			}
		}()
		return handler(ctx, req)
	}
}

// authInterceptor refuses peer calls that do not carry the cluster secret.
// With no secret configured every call is accepted, as in a local demo.
func authInterceptor(secret string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if secret == "" {
			return handler(ctx, req)
		}
		md, _ := metadata.FromIncomingContext(ctx)
		got := md.Get(secretHeader)
		if len(got) == 0 || subtle.ConstantTimeCompare([]byte(got[0]), []byte(secret)) != 1 {
			return nil, status.Error(codes.Unauthenticated, "missing or wrong cluster secret")
		}
		return handler(ctx, req)
	}
}

// partitionInterceptor refuses calls from a peer this node is simulating a
// network cut with.
func partitionInterceptor(n *Node) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if md, ok := metadata.FromIncomingContext(ctx); ok {
			if from := md.Get(fromHeader); len(from) > 0 && n.partitionedFrom(from[0]) {
				return nil, status.Error(codes.Unavailable, "partitioned")
			}
		}
		return handler(ctx, req)
	}
}

// rpcServer answers peers. Every data call goes through the same LocalPeer
// the coordinator uses for its own replica.
type rpcServer struct {
	nodepb.UnimplementedNodeServer
	n *Node
}

func (s *rpcServer) Replicate(ctx context.Context, req *nodepb.ReplicateRequest) (*nodepb.ReplicateResponse, error) {
	meta, err := metaFromPB(req.GetMeta())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	res, err := s.n.local.Replicate(ctx, meta, req.GetBody(), req.GetReason())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	return &nodepb.ReplicateResponse{Stored: res.Stored, Current: metaToPB(res.Current)}, nil
}

func (s *rpcServer) GetReplica(ctx context.Context, req *nodepb.GetReplicaRequest) (*nodepb.GetReplicaResponse, error) {
	rep, err := s.n.local.GetReplica(ctx, req.GetKey(), req.GetWithBody())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	out := &nodepb.GetReplicaResponse{Found: rep.Found, Corrupt: rep.Corrupt, Hinted: rep.Hinted, Body: rep.Body}
	if rep.Found {
		out.Meta = metaToPB(rep.Meta)
	}
	return out, nil
}

func (s *rpcServer) Repair(ctx context.Context, req *nodepb.RepairRequest) (*nodepb.RepairResponse, error) {
	reason := repair.Reason(req.GetReason())
	if reason == "" {
		reason = repair.ReasonManual
	}
	rep, err := s.n.repairer.Repair(ctx, req.GetKey(), reason)
	if err != nil && !errors.Is(err, repair.ErrNoHealthyReplica) {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &nodepb.RepairResponse{
		WinnerVersion: rep.Winner.Version,
		Pushed:        rep.Pushed,
		Corrupt:       rep.Corrupt,
		TookMicros:    rep.Took.Microseconds(),
	}, nil
}

func (s *rpcServer) Hint(ctx context.Context, req *nodepb.HintRequest) (*nodepb.HintResponse, error) {
	meta, err := metaFromPB(req.GetMeta())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if err := s.n.local.Hint(ctx, req.GetTarget(), meta, req.GetBody()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	return &nodepb.HintResponse{Accepted: true}, nil
}

func (s *rpcServer) RingSnapshot(context.Context, *nodepb.RingSnapshotRequest) (*nodepb.RingSnapshotResponse, error) {
	version, digest, _ := s.n.mem.Ring()
	out := &nodepb.RingSnapshotResponse{RingVersion: version, RingDigest: digest}
	for _, m := range s.n.mem.Members() {
		out.Members = append(out.Members, &nodepb.Member{
			Id: m.ID, Addr: m.GossipAddr, Status: string(m.Status), RingVersion: m.RingVersion,
			GrpcAddr: m.GRPCAddr, HttpAddr: m.HTTPAddr, PublicUrl: m.PublicURL, InRing: m.InRing,
		})
	}
	return out, nil
}

func (s *rpcServer) ListReplicas(ctx context.Context, _ *nodepb.ListReplicasRequest) (*nodepb.ListReplicasResponse, error) {
	inv, err := s.n.local.Inventory(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	out := &nodepb.ListReplicasResponse{Tampered: inv.Tampered, Bytes: inv.Bytes, IndexErrors: uint64(inv.IndexErrors)}
	for _, m := range inv.Objects {
		out.Objects = append(out.Objects, metaToPB(m))
	}
	for _, m := range inv.Hints {
		out.Hints = append(out.Hints, metaToPB(m))
	}
	return out, nil
}

func (s *rpcServer) Events(_ context.Context, req *nodepb.EventsRequest) (*nodepb.EventsResponse, error) {
	out := &nodepb.EventsResponse{}
	for _, ev := range s.n.log.Since(req.GetSince(), int(req.GetLimit())) {
		out.Events = append(out.Events, &nodepb.Event{
			Seq: ev.Seq, AtUnixMs: ev.At.UnixMilli(), Node: ev.Node, Kind: string(ev.Kind),
			Level: string(ev.Level), Key: ev.Key, Message: ev.Message, Fields: ev.Fields,
		})
	}
	return out, nil
}

func (s *rpcServer) Corrupt(_ context.Context, req *nodepb.CorruptRequest) (*nodepb.CorruptResponse, error) {
	if err := s.n.corruptLocal(req.GetKey()); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, status.Error(codes.NotFound, err.Error())
		}
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &nodepb.CorruptResponse{Corrupted: true}, nil
}

func (s *rpcServer) Scrub(ctx context.Context, _ *nodepb.ScrubRequest) (*nodepb.ScrubResponse, error) {
	res, err := s.n.scrubber.ScrubPass(ctx, true)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &nodepb.ScrubResponse{
		Checked: uint64(res.Checked), Mismatches: uint64(res.Mismatches),
		HintsChecked: uint64(res.HintsChecked), HintsDropped: uint64(res.HintsDropped),
	}, nil
}

func (n *Node) corruptLocal(key string) error {
	if err := n.store.Corrupt(key); err != nil {
		return err
	}
	n.log.Emit(events.KindFault, events.LevelErr, key,
		fmt.Sprintf("operator flipped a byte in %s on %s; nothing has checked it yet", key, n.cfg.ID), nil)
	return nil
}

// --- client side -------------------------------------------------------------

func (n *Node) conn(addr string) (*grpc.ClientConn, error) {
	n.connMu.Lock()
	defer n.connMu.Unlock()
	if c, ok := n.conns[addr]; ok {
		return c, nil
	}
	c, err := grpc.NewClient(addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(clientKeepalive),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxMessage), grpc.MaxCallSendMsgSize(maxMessage)),
		grpc.WithConnectParams(grpc.ConnectParams{
			Backoff:           backoff.Config{BaseDelay: 100 * time.Millisecond, Multiplier: 1.6, Jitter: 0.2, MaxDelay: 2 * time.Second},
			MinConnectTimeout: time.Second,
		}),
		grpc.WithUnaryInterceptor(func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
			ctx = metadata.AppendToOutgoingContext(ctx, fromHeader, n.cfg.ID)
			if n.cfg.ClusterSecret != "" {
				ctx = metadata.AppendToOutgoingContext(ctx, secretHeader, n.cfg.ClusterSecret)
			}
			return invoker(ctx, method, req, reply, cc, opts...)
		}),
	)
	if err != nil {
		return nil, err
	}
	n.conns[addr] = c
	return c, nil
}

// remotePeer is a replica.Peer backed by gRPC. It looks up the peer's
// address from gossip on every call, so a node that comes back on a new
// address is still found.
type remotePeer struct {
	n  *Node
	id string
}

var errPartitioned = status.Error(codes.Unavailable, "partitioned")

func (p *remotePeer) client() (nodepb.NodeClient, error) {
	if p.n.partitionedFrom(p.id) {
		return nil, errPartitioned
	}
	m, ok := p.n.mem.Member(p.id)
	if !ok || m.GRPCAddr == "" {
		return nil, status.Errorf(codes.Unavailable, "no address known for %s", p.id)
	}
	c, err := p.n.conn(m.GRPCAddr)
	if err != nil {
		return nil, err
	}
	return nodepb.NewNodeClient(c), nil
}

func (p *remotePeer) ID() string { return p.id }

func (p *remotePeer) Replicate(ctx context.Context, meta store.ObjectMeta, body []byte, reason string) (store.PutResult, error) {
	c, err := p.client()
	if err != nil {
		return store.PutResult{}, err
	}
	res, err := c.Replicate(ctx, &nodepb.ReplicateRequest{Meta: metaToPB(meta), Body: body, Reason: reason})
	if err != nil {
		return store.PutResult{}, err
	}
	cur, err := metaFromPB(res.GetCurrent())
	if err != nil {
		return store.PutResult{}, err
	}
	return store.PutResult{Stored: res.GetStored(), Current: cur}, nil
}

func (p *remotePeer) GetReplica(ctx context.Context, key string, withBody bool) (replica.Replica, error) {
	c, err := p.client()
	if err != nil {
		return replica.Replica{}, err
	}
	res, err := c.GetReplica(ctx, &nodepb.GetReplicaRequest{Key: key, WithBody: withBody})
	if err != nil {
		return replica.Replica{}, err
	}
	rep := replica.Replica{Node: p.id, Found: res.GetFound(), Corrupt: res.GetCorrupt(), Hinted: res.GetHinted(), Body: res.GetBody()}
	if rep.Found {
		if rep.Meta, err = metaFromPB(res.GetMeta()); err != nil {
			return replica.Replica{}, err
		}
	}
	return rep, nil
}

func (p *remotePeer) Hint(ctx context.Context, target string, meta store.ObjectMeta, body []byte) error {
	c, err := p.client()
	if err != nil {
		return err
	}
	_, err = c.Hint(ctx, &nodepb.HintRequest{Target: target, Meta: metaToPB(meta), Body: body})
	return err
}

func (p *remotePeer) Inventory(ctx context.Context) (replica.Inventory, error) {
	c, err := p.client()
	if err != nil {
		return replica.Inventory{}, err
	}
	res, err := c.ListReplicas(ctx, &nodepb.ListReplicasRequest{})
	if err != nil {
		return replica.Inventory{}, err
	}
	inv := replica.Inventory{Node: p.id, Tampered: res.GetTampered(), Bytes: res.GetBytes(), IndexErrors: int(res.GetIndexErrors())}
	for _, m := range res.GetObjects() {
		meta, err := metaFromPB(m)
		if err != nil {
			return replica.Inventory{}, err
		}
		inv.Objects = append(inv.Objects, meta)
	}
	for _, m := range res.GetHints() {
		meta, err := metaFromPB(m)
		if err != nil {
			return replica.Inventory{}, err
		}
		inv.Hints = append(inv.Hints, meta)
	}
	return inv, nil
}

func (p *remotePeer) events(ctx context.Context, since uint64, limit uint32) ([]events.Event, error) {
	c, err := p.client()
	if err != nil {
		return nil, err
	}
	res, err := c.Events(ctx, &nodepb.EventsRequest{Since: since, Limit: limit})
	if err != nil {
		return nil, err
	}
	out := make([]events.Event, 0, len(res.GetEvents()))
	for _, e := range res.GetEvents() {
		out = append(out, events.Event{
			Seq: e.GetSeq(), At: time.UnixMilli(e.GetAtUnixMs()).UTC(), Node: e.GetNode(),
			Kind: events.Kind(e.GetKind()), Level: events.Level(e.GetLevel()), Key: e.GetKey(),
			Message: e.GetMessage(), Fields: e.GetFields(),
		})
	}
	return out, nil
}

func (p *remotePeer) corrupt(ctx context.Context, key string) error {
	c, err := p.client()
	if err != nil {
		return err
	}
	_, err = c.Corrupt(ctx, &nodepb.CorruptRequest{Key: key})
	return err
}

func (p *remotePeer) scrub(ctx context.Context) (repair.ScrubResult, error) {
	c, err := p.client()
	if err != nil {
		return repair.ScrubResult{}, err
	}
	res, err := c.Scrub(ctx, &nodepb.ScrubRequest{})
	if err != nil {
		return repair.ScrubResult{}, err
	}
	return repair.ScrubResult{
		Checked: int(res.GetChecked()), Mismatches: int(res.GetMismatches()),
		HintsChecked: int(res.GetHintsChecked()), HintsDropped: int(res.GetHintsDropped()),
	}, nil
}

func metaToPB(m store.ObjectMeta) *nodepb.ObjectMeta {
	var written int64
	if !m.WrittenAt.IsZero() {
		written = m.WrittenAt.UnixMilli()
	}
	return &nodepb.ObjectMeta{
		Key: m.Key, Version: m.Version, Checksum: m.Checksum[:], Size: m.Size, Origin: m.Origin,
		HintedFor: m.HintedFor, Deleted: m.Deleted, WrittenUnixMs: written, ContentType: m.ContentType,
	}
}

func metaFromPB(p *nodepb.ObjectMeta) (store.ObjectMeta, error) {
	if p == nil {
		return store.ObjectMeta{}, errors.New("missing object meta")
	}
	m := store.ObjectMeta{
		Key: p.GetKey(), Version: p.GetVersion(), Size: p.GetSize(), Origin: p.GetOrigin(),
		HintedFor: p.GetHintedFor(), Deleted: p.GetDeleted(), ContentType: p.GetContentType(),
	}
	if len(p.GetChecksum()) != len(m.Checksum) {
		return store.ObjectMeta{}, fmt.Errorf("checksum is %d bytes, want %d", len(p.GetChecksum()), len(m.Checksum))
	}
	copy(m.Checksum[:], p.GetChecksum())
	if ms := p.GetWrittenUnixMs(); ms != 0 {
		m.WrittenAt = time.UnixMilli(ms).UTC()
	}
	return m, nil
}
