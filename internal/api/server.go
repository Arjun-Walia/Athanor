// Package api is the client and admin HTTP surface of one node. Peer RPC is
// gRPC and lives in internal/node.
//
// Client routes (any node coordinates):
//
//	PUT    /v1/objects/{key...}   write, 201 after W acks, 503 without quorum
//	GET    /v1/objects/{key...}   read R replicas, newest verified version wins
//	DELETE /v1/objects/{key...}   tombstone write, same quorum as PUT
//
// Admin routes:
//
//	GET    /v1/admin/health              this process (answers while stopped)
//	GET    /v1/admin/cluster             gossiped members and ring version
//	GET    /v1/admin/overview            members + replica map + metrics
//	GET    /v1/admin/objects             replica map + metrics
//	GET    /v1/admin/ring?key=           vnode positions, optional placement
//	GET    /v1/admin/events              merged event log of reachable nodes
//	GET    /v1/admin/config              cluster N/W/R
//	PUT    /v1/admin/config              change N/W/R, gossiped to all nodes
//	POST   /v1/admin/scrub               scrub every reachable node now
//	POST   /v1/admin/repair/{key...}     run Repair(key) now
//	POST   /v1/admin/corrupt             flip a byte: {"key","node"}
//	POST   /v1/admin/nodes/{id}/stop     crash-stop a node (via its admin API)
//	POST   /v1/admin/nodes/{id}/start    bring it back
//	POST   /v1/admin/partitions          cut the network: {"a","b"}
//	DELETE /v1/admin/partitions          heal every partition
//	POST   /v1/admin/fault/{stop,start,block,unblock}   this node only
//
// There is no authentication. This API is for a local demo cluster.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/node"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/ring"
)

// Mode is the process mode reported by health.
const Mode = "engine"

// DefaultMaxUpload caps one object. Peer RPC allows a little more.
const DefaultMaxUpload = 64 << 20

// Options tune the HTTP surface.
type Options struct {
	UI        http.Handler // optional dashboard + landing page
	MaxUpload int64
}

// Server serves one node's HTTP API.
type Server struct {
	node   *node.Node
	opts   Options
	client *http.Client
}

// NewServer returns the HTTP API for n.
func NewServer(n *node.Node, opts Options) *Server {
	if opts.MaxUpload <= 0 {
		opts.MaxUpload = DefaultMaxUpload
	}
	return &Server{node: n, opts: opts, client: &http.Client{Timeout: 5 * time.Second}}
}

// Handler is the HTTP handler, including CORS for the browser dashboard.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/{$}", s.root)
	mux.HandleFunc("GET /v1/admin/health", s.health)
	mux.HandleFunc("GET /v1/admin/cluster", s.cluster)
	mux.HandleFunc("GET /v1/admin/overview", s.overview)
	mux.HandleFunc("GET /v1/admin/objects", s.objects)
	mux.HandleFunc("GET /v1/admin/ring", s.ring)
	mux.HandleFunc("GET /v1/admin/events", s.events)
	mux.HandleFunc("GET /v1/admin/config", s.getConfig)
	mux.HandleFunc("PUT /v1/admin/config", s.putConfig)
	mux.HandleFunc("POST /v1/admin/scrub", s.scrub)
	mux.HandleFunc("POST /v1/admin/repair/{key...}", s.repair)
	mux.HandleFunc("POST /v1/admin/corrupt", s.corrupt)
	mux.HandleFunc("POST /v1/admin/nodes/{id}/{action}", s.nodeAction)
	mux.HandleFunc("POST /v1/admin/partitions", s.partition)
	mux.HandleFunc("DELETE /v1/admin/partitions", s.healPartitions)
	mux.HandleFunc("POST /v1/admin/fault/{action}", s.fault)
	mux.HandleFunc("PUT /v1/objects/{key...}", s.putObject)
	mux.HandleFunc("GET /v1/objects/{key...}", s.getObject)
	mux.HandleFunc("DELETE /v1/objects/{key...}", s.deleteObject)
	if s.opts.UI != nil {
		mux.Handle("GET /", s.opts.UI)
	} else {
		mux.HandleFunc("GET /{$}", s.root)
	}
	return withCORS(mux)
}

func (s *Server) root(w http.ResponseWriter, _ *http.Request) {
	body := map[string]any{
		"name":   "athanor",
		"binary": "vault-node",
		"node":   s.node.ID(),
		"mode":   Mode,
		"health": "/v1/admin/health",
	}
	if s.opts.UI != nil {
		body["dashboard"] = "/app"
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	h := s.node.Health()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":       "ok",
		"mode":         Mode,
		"node_id":      h.NodeID,
		"state":        h.State,
		"quorum":       h.Quorum,
		"ring_version": h.RingVersion,
		"booted_at":    h.BootedAt,
		"started_at":   h.StartedAt,
		"scrub":        h.Scrub,
		"scrub_every":  h.Scrub.Interval.Seconds(),
		"store":        h.Store,
		"ui":           s.opts.UI != nil,
	})
}

func (s *Server) cluster(w http.ResponseWriter, _ *http.Request) {
	version, digest, set := s.node.Membership().Ring()
	writeJSON(w, http.StatusOK, map[string]any{
		"node_id":      s.node.ID(),
		"running":      s.node.Running(),
		"ring_version": version,
		"ring_digest":  digest,
		"ring_members": set,
		"quorum":       s.node.Quorum(),
		"config":       s.node.ClusterConfig(),
		"partitions":   s.node.Membership().Blocked(),
		"nodes":        s.node.Membership().Members(),
	})
}

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	ov, err := s.node.Overview(r.Context(), r.URL.Query().Get("deleted") == "1")
	if err != nil {
		writeStopped(w, s.node.ID(), err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) objects(w http.ResponseWriter, r *http.Request) {
	ov, err := s.node.Overview(r.Context(), r.URL.Query().Get("deleted") == "1")
	if err != nil {
		writeStopped(w, s.node.ID(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"objects": ov.Objects, "metrics": ov.Metrics, "quorum": ov.Config.Quorum})
}

func (s *Server) ring(w http.ResponseWriter, r *http.Request) {
	rg := s.node.Ring()
	type token struct {
		Node string  `json:"node"`
		Pos  float64 `json:"pos"`
	}
	tokens := make([]token, 0, len(rg.Tokens()))
	for _, t := range rg.Tokens() {
		tokens = append(tokens, token{Node: t.Node, Pos: position(t.Hash)})
	}
	body := map[string]any{
		"version": rg.Version(),
		"digest":  rg.Digest(),
		"nodes":   rg.Nodes(),
		"tokens":  tokens,
	}
	if key := r.URL.Query().Get("key"); key != "" {
		q := s.node.Quorum()
		walk := rg.Walk(key)
		n := min(q.N, len(walk))
		body["placement"] = map[string]any{
			"key":        key,
			"pos":        position(ring.KeyHash(key)),
			"preference": walk[:n],
			"fallbacks":  walk[n:],
		}
	}
	writeJSON(w, http.StatusOK, body)
}

func position(h uint64) float64 { return float64(h) / math.Exp2(64) }

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	writeJSON(w, http.StatusOK, map[string]any{
		"node":   s.node.ID(),
		"events": s.node.ClusterEvents(r.Context(), limit),
	})
}

func (s *Server) getConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.node.ClusterConfig())
}

func (s *Server) putConfig(w http.ResponseWriter, r *http.Request) {
	var q replica.Quorum
	if err := decodeBody(r, &q); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !s.node.Running() {
		writeStopped(w, s.node.ID(), node.ErrStopped)
		return
	}
	cfg, err := s.node.SetQuorum(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) scrub(w http.ResponseWriter, r *http.Request) {
	res, err := s.node.ScrubAll(r.Context())
	if err != nil {
		writeStopped(w, s.node.ID(), err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": res})
}

func (s *Server) repair(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	rep, err := s.node.Repair(r.Context(), key)
	if errors.Is(err, node.ErrStopped) {
		writeStopped(w, s.node.ID(), err)
		return
	}
	body := map[string]any{
		"key":     key,
		"reason":  rep.Reason,
		"source":  rep.Source,
		"pushed":  nonNil(rep.Pushed),
		"corrupt": nonNil(rep.Corrupt),
		"stale":   nonNil(rep.Stale),
		"missing": nonNil(rep.Missing),
		"took_ms": float64(rep.Took.Microseconds()) / 1000,
	}
	if err != nil {
		body["error"] = err.Error()
		writeJSON(w, http.StatusConflict, body)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) corrupt(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Key  string `json:"key"`
		Node string `json:"node"`
	}
	if err := decodeBody(r, &req); err != nil || req.Key == "" {
		writeError(w, http.StatusBadRequest, errors.New(`body must be {"key": "...", "node": "..."}`))
		return
	}
	if err := s.node.Corrupt(r.Context(), req.Key, req.Node); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	target := req.Node
	if target == "" {
		target = s.node.ID()
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": req.Key, "node": target, "corrupted": true})
}

// nodeAction stops or starts any node by calling that node's own admin API.
// Addresses come from gossip, and dead members keep their last address, so
// a stopped node can still be started from here.
func (s *Server) nodeAction(w http.ResponseWriter, r *http.Request) {
	id, action := r.PathValue("id"), r.PathValue("action")
	if action != "stop" && action != "start" {
		writeError(w, http.StatusNotFound, fmt.Errorf("unknown action %q", action))
		return
	}
	status, body := s.forward(r.Context(), id, "/v1/admin/fault/"+action, nil)
	writeRaw(w, status, body)
}

func (s *Server) partition(w http.ResponseWriter, r *http.Request) {
	var req struct {
		A string `json:"a"`
		B string `json:"b"`
	}
	if err := decodeBody(r, &req); err != nil || req.A == "" || req.B == "" || req.A == req.B {
		writeError(w, http.StatusBadRequest, errors.New(`body must be {"a": "node1", "b": "node3"} with two different nodes`))
		return
	}
	sa, ba := s.forward(r.Context(), req.A, "/v1/admin/fault/block", map[string]string{"peer": req.B})
	sb, bb := s.forward(r.Context(), req.B, "/v1/admin/fault/block", map[string]string{"peer": req.A})
	status := http.StatusOK
	if sa >= 300 || sb >= 300 {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, map[string]any{
		"partitioned": []string{req.A, req.B},
		"results":     map[string]json.RawMessage{req.A: ba, req.B: bb},
	})
}

func (s *Server) healPartitions(w http.ResponseWriter, r *http.Request) {
	results := map[string]json.RawMessage{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range s.node.Membership().Members() {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, body := s.forward(r.Context(), id, "/v1/admin/fault/unblock", map[string]string{})
			mu.Lock()
			results[id] = body
			mu.Unlock()
		}(m.ID)
	}
	wg.Wait()
	writeJSON(w, http.StatusOK, map[string]any{"healed": true, "results": results})
}

// fault is this node's own fault-injection surface.
func (s *Server) fault(w http.ResponseWriter, r *http.Request) {
	status, body := s.applyFault(r.PathValue("action"), r.Body)
	writeRaw(w, status, body)
}

func (s *Server) applyFault(action string, reqBody io.Reader) (int, []byte) {
	var req struct {
		Peer string `json:"peer"`
	}
	if reqBody != nil {
		_ = json.NewDecoder(io.LimitReader(reqBody, 4096)).Decode(&req)
	}
	switch action {
	case "stop":
		s.node.Stop()
	case "start":
		if err := s.node.Start(); err != nil {
			return marshal(http.StatusInternalServerError, map[string]string{"error": err.Error(), "node": s.node.ID()})
		}
	case "block":
		if err := s.node.Block(req.Peer); err != nil {
			return marshal(http.StatusBadRequest, map[string]string{"error": err.Error()})
		}
	case "unblock":
		s.node.Unblock(req.Peer)
	default:
		return marshal(http.StatusNotFound, map[string]string{"error": "unknown fault action " + action})
	}
	state := "running"
	if !s.node.Running() {
		state = "stopped"
	}
	return marshal(http.StatusOK, map[string]any{
		"node": s.node.ID(), "action": action, "state": state, "partitions": s.node.Membership().Blocked(),
	})
}

func (s *Server) forward(ctx context.Context, id, path string, payload any) (int, []byte) {
	if id == s.node.ID() {
		var body io.Reader
		if payload != nil {
			raw, _ := json.Marshal(payload)
			body = bytes.NewReader(raw)
		}
		return s.applyFault(strings.TrimPrefix(path, "/v1/admin/fault/"), body)
	}
	m, ok := s.node.Membership().Member(id)
	if !ok || m.HTTPAddr == "" {
		return marshal(http.StatusNotFound, map[string]string{"error": "no known address for " + id})
	}
	var body io.Reader
	if payload != nil {
		raw, _ := json.Marshal(payload)
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+m.HTTPAddr+path, body)
	if err != nil {
		return marshal(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return marshal(http.StatusBadGateway, map[string]string{
			"error": fmt.Sprintf("could not reach %s's admin API at %s: %v", id, m.HTTPAddr, err),
		})
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, raw
}

// --- objects ----------------------------------------------------------------

func (s *Server) putObject(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !s.dataPlaneUp(w) || !validKey(w, key) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.opts.MaxUpload))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, fmt.Errorf("object larger than %d MiB", s.opts.MaxUpload>>20))
		return
	}
	ctype := r.Header.Get("Content-Type")
	if ctype == "" {
		ctype = http.DetectContentType(body)
	}
	res, err := s.node.Coordinator().Put(r.Context(), key, body, ctype)
	s.writeWrite(w, http.StatusCreated, res, err)
}

func (s *Server) deleteObject(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !s.dataPlaneUp(w) || !validKey(w, key) {
		return
	}
	res, err := s.node.Coordinator().Delete(r.Context(), key)
	s.writeWrite(w, http.StatusOK, res, err)
}

func (s *Server) writeWrite(w http.ResponseWriter, okStatus int, res replica.WriteResult, err error) {
	type ack struct {
		Node    string  `json:"node"`
		HintFor string  `json:"hint_for,omitempty"`
		TookMS  float64 `json:"took_ms"`
	}
	acks := make([]ack, 0, len(res.Acks))
	for _, a := range res.Acks {
		acks = append(acks, ack{Node: a.Node, HintFor: a.HintFor, TookMS: ms(a.Took)})
	}
	body := map[string]any{
		"key":         res.Meta.Key,
		"version":     strconv.FormatUint(res.Meta.Version, 10),
		"checksum":    res.Meta.ChecksumHex(),
		"size":        res.Meta.Size,
		"deleted":     res.Meta.Deleted,
		"preference":  nonNil(res.Preference),
		"acks":        acks,
		"quorum":      res.Quorum,
		"coordinator": res.Coordinator,
		"took_ms":     ms(res.Took),
	}
	var qe *replica.QuorumError
	switch {
	case errors.As(err, &qe):
		body["error"] = qe.Error()
		body["needed"] = qe.Need
		writeJSON(w, http.StatusServiceUnavailable, body)
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, err)
	default:
		writeJSON(w, okStatus, body)
	}
}

func (s *Server) getObject(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !s.dataPlaneUp(w) || !validKey(w, key) {
		return
	}
	res, err := s.node.Coordinator().Get(r.Context(), key)
	var qe *replica.QuorumError
	switch {
	case errors.As(err, &qe):
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error": qe.Error(), "key": key, "needed": qe.Need, "answered": nonNil(qe.Nodes),
		})
		return
	case errors.Is(err, replica.ErrNotFound):
		body := map[string]any{"error": "not found", "key": key}
		if res.Meta.Deleted {
			body["deleted"] = true
		}
		writeJSON(w, http.StatusNotFound, body)
		return
	case err != nil:
		writeError(w, http.StatusServiceUnavailable, err)
		return
	}

	labels := make([]string, 0, len(res.Replicas))
	for _, rs := range res.Replicas {
		labels = append(labels, rs.Node+"="+rs.Status)
	}
	sort.Strings(labels)
	h := w.Header()
	ctype := res.Meta.ContentType
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	h.Set("Content-Type", ctype)
	h.Set("Content-Length", strconv.Itoa(len(res.Body)))
	h.Set("ETag", `"`+res.Meta.ChecksumHex()+`"`)
	h.Set("X-Athanor-Version", strconv.FormatUint(res.Meta.Version, 10))
	h.Set("X-Athanor-Checksum", res.Meta.ChecksumHex())
	h.Set("X-Athanor-Coordinator", res.Coordinator)
	h.Set("X-Athanor-Replicas", strings.Join(labels, ","))
	h.Set("X-Athanor-Degraded", strconv.FormatBool(res.Degraded))
	if r.URL.Query().Get("download") == "1" {
		h.Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", path.Base(key)))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(res.Body)
	}
}

func (s *Server) dataPlaneUp(w http.ResponseWriter) bool {
	if s.node.Running() {
		return true
	}
	writeStopped(w, s.node.ID(), node.ErrStopped)
	return false
}

func validKey(w http.ResponseWriter, key string) bool {
	if key == "" || len(key) > 1024 || strings.ContainsRune(key, 0) {
		writeError(w, http.StatusBadRequest, errors.New("key must be 1-1024 bytes with no NUL"))
		return false
	}
	return true
}

// --- helpers ----------------------------------------------------------------

func ms(d time.Duration) float64 { return math.Round(float64(d.Microseconds())/10) / 100 }

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func decodeBody(r *http.Request, v any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<16))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func marshal(status int, v any) (int, []byte) {
	raw, err := json.Marshal(v)
	if err != nil {
		return http.StatusInternalServerError, []byte(`{"error":"encode"}`)
	}
	return status, raw
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeStopped(w http.ResponseWriter, id string, err error) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": err.Error(), "node": id, "stopped": true})
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write json: %v", err)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		h.Set("Access-Control-Expose-Headers",
			"ETag, Content-Disposition, X-Athanor-Version, X-Athanor-Checksum, X-Athanor-Coordinator, X-Athanor-Replicas, X-Athanor-Degraded")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
