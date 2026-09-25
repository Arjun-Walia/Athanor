// Command vault-node is one Athanor storage process.
//
// Every node is a stateless coordinator for client HTTP, a gRPC peer, and a
// SWIM gossip member. Start five of them with deploy/docker-compose.yml, or
// locally with scripts/local-cluster.sh.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/Arjun-Walia/Athanor/internal/api"
	"github.com/Arjun-Walia/Athanor/internal/node"
	"github.com/Arjun-Walia/Athanor/internal/replica"
	"github.com/Arjun-Walia/Athanor/internal/ring"
	"github.com/Arjun-Walia/Athanor/internal/webui"
)

var validID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)

func main() {
	def := replica.DefaultQuorum()
	id := flag.String("id", "node1", "node id (letters, digits, . _ -)")
	httpAddr := flag.String("http", ":8080", "client and admin HTTP listen address")
	grpcAddr := flag.String("grpc", ":9090", "peer gRPC listen address")
	gossipAddr := flag.String("gossip", "0.0.0.0:7946", "memberlist (SWIM) bind address")
	advertise := flag.String("advertise", "", "host other nodes use to reach this one (default: the gossip IP)")
	publicURL := flag.String("public-url", "", "browser-facing URL of this node's HTTP API (default: http://localhost:<http port>)")
	dataDir := flag.String("data", "./data", "local blob and index directory")
	seeds := flag.String("seeds", "", "comma-separated gossip seeds, host or host:port (port defaults to 7946)")
	n := flag.Int("n", def.N, "replicas per object (N)")
	w := flag.Int("w", def.W, "write acks before success (W)")
	r := flag.Int("r", def.R, "replicas read before answering (R)")
	vnodes := flag.Int("vnodes", ring.DefaultVNodes, "virtual nodes per physical node")
	scrub := flag.Duration("scrub-interval", 30*time.Second, "how often every local checksum is re-verified")
	reap := flag.Duration("reap-after", 2*time.Minute, "how long a dead node stays in the ring before its keys are re-replicated")
	rate := flag.Float64("rebalance-rate", 20, "rebalance copies per second")
	serveUI := flag.Bool("ui", true, "serve the embedded dashboard at / and /app when the binary was built with it")
	flag.Parse()

	if !validID.MatchString(*id) {
		log.Fatalf("invalid --id %q", *id)
	}
	q := replica.Quorum{N: *n, W: *w, R: *r}
	if err := q.Validate(); err != nil {
		log.Fatalf("invalid quorum: %v", err)
	}
	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("data dir: %v", err)
	}
	if *publicURL == "" {
		if _, port, err := net.SplitHostPort(*httpAddr); err == nil {
			*publicURL = "http://localhost:" + port
		}
	}

	nd, err := node.New(node.Config{
		ID:            *id,
		DataDir:       *dataDir,
		HTTPAddr:      *httpAddr,
		GRPCAddr:      *grpcAddr,
		GossipAddr:    *gossipAddr,
		Advertise:     *advertise,
		PublicURL:     *publicURL,
		Seeds:         seedList(*seeds),
		Quorum:        q,
		VNodes:        *vnodes,
		ScrubInterval: *scrub,
		ReapAfter:     *reap,
		RebalanceRate: *rate,
	})
	if err != nil {
		log.Fatal(err)
	}

	opts := api.Options{}
	if *serveUI {
		if h, ok := webui.Handler(); ok {
			opts.UI = h
		}
	}
	server := &http.Server{
		Addr:              *httpAddr,
		Handler:           api.NewServer(nd, opts).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	if err := nd.Start(); err != nil {
		log.Fatal(err)
	}
	log.Printf("vault-node id=%s http=%s grpc=%s gossip=%s data=%s quorum=%s ui=%v",
		*id, *httpAddr, *grpcAddr, *gossipAddr, *dataDir, q, opts.UI != nil)

	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	if err := nd.Close(); err != nil {
		log.Printf("close: %v", err)
	}
}

func seedList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(part); err != nil {
			part = fmt.Sprintf("%s:7946", part)
		}
		out = append(out, part)
	}
	return out
}
