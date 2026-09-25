// Package api is the client HTTP surface and, from Phase B, the gRPC peer API.
//
// HTTP routes:
//
//	GET    /v1/admin/health
//	GET    /v1/admin/cluster
//	GET    /v1/admin/events
//	PUT    /v1/objects/{key}
//	GET    /v1/objects/{key}
//	DELETE /v1/objects/{key}
//
// Object routes return 501 until the local store exists. Health and cluster
// describe this process only. They do not imply a gossiped ring.
package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/Arjun-Walia/Athanor/internal/replica"
)

// Mode is the process mode reported by health. It stays "scaffold" until
// Put and Get persist bytes.
const Mode = "scaffold"

// Config is the process identity the HTTP handlers are allowed to report.
type Config struct {
	NodeID   string
	HTTPAddr string
	GRPCAddr string
	DataDir  string
	Seeds    []string
	Quorum   replica.Quorum
}

// Server serves the scaffold HTTP API.
type Server struct {
	cfg Config
}

// NewServer returns a handler set for cfg.
func NewServer(cfg Config) *Server {
	if cfg.Seeds == nil {
		cfg.Seeds = []string{}
	}
	return &Server{cfg: cfg}
}

// Handler is the HTTP handler, including CORS for the browser dashboard.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.root)
	mux.HandleFunc("GET /v1/admin/health", s.health)
	mux.HandleFunc("GET /v1/admin/cluster", s.cluster)
	mux.HandleFunc("GET /v1/admin/events", s.events)
	mux.HandleFunc("PUT /v1/objects/{key...}", s.objectNotReady)
	mux.HandleFunc("GET /v1/objects/{key...}", s.objectNotReady)
	mux.HandleFunc("DELETE /v1/objects/{key...}", s.objectNotReady)
	return withCORS(mux)
}

func (s *Server) root(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"name":   "athanor",
		"binary": "vault-node",
		"mode":   Mode,
		"health": "/v1/admin/health",
	})
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"node_id": s.cfg.NodeID,
		"mode":    Mode,
		"quorum":  quorumJSON(s.cfg.Quorum),
	})
}

func (s *Server) cluster(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"implemented":  false,
		"ring_version": 0,
		"quorum":       quorumJSON(s.cfg.Quorum),
		"seeds":        s.cfg.Seeds,
		"nodes": []map[string]string{{
			"id":        s.cfg.NodeID,
			"status":    "alive",
			"http_addr": s.cfg.HTTPAddr,
			"grpc_addr": s.cfg.GRPCAddr,
		}},
	})
}

func (s *Server) events(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"implemented": false,
		"events":      []any{},
	})
}

func (s *Server) objectNotReady(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusNotImplemented, map[string]string{
		"error": "not implemented",
		"phase": "A",
		"key":   r.PathValue("key"),
	})
}

func quorumJSON(q replica.Quorum) map[string]int {
	return map[string]int{"n": q.N, "w": q.W, "r": q.R}
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
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
