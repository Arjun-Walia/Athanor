// Command vault-node is one Athanor storage process.
//
// The process is the stateless coordinator for client HTTP and, once Phase B
// lands, a gRPC peer. This scaffold serves the admin and object routes and
// records the addresses the later phases will bind.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/api"
	"github.com/Arjun-Walia/Athanor/internal/replica"
)

func main() {
	id := flag.String("id", "node1", "node id")
	httpAddr := flag.String("http", ":8080", "client and admin HTTP listen address")
	grpcAddr := flag.String("grpc", ":9090", "gRPC listen address (recorded only until Phase B)")
	dataDir := flag.String("data", "./data", "local blob and index directory")
	seeds := flag.String("seeds", "", "comma-separated memberlist seed hosts")
	flag.Parse()

	if strings.TrimSpace(*id) == "" {
		log.Fatal("id is required")
	}
	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("data dir: %v", err)
	}

	cfg := api.Config{
		NodeID:   *id,
		HTTPAddr: *httpAddr,
		GRPCAddr: *grpcAddr,
		DataDir:  *dataDir,
		Seeds:    splitCSV(*seeds),
		Quorum:   replica.DefaultQuorum(),
	}
	log.Printf("vault-node id=%s http=%s grpc=%s (not listening) data=%s quorum=%d/%d/%d mode=%s",
		cfg.NodeID, cfg.HTTPAddr, cfg.GRPCAddr, cfg.DataDir, cfg.Quorum.N, cfg.Quorum.W, cfg.Quorum.R, api.Mode)

	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.NewServer(cfg).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func splitCSV(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
