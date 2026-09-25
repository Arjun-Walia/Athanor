// Command vault-node is one Athanor storage process.
//
// Every node is a stateless coordinator for client HTTP, a gRPC peer, and a
// SWIM gossip member. Start five of them with deploy/docker-compose.yml, or
// locally with scripts/local-cluster.sh.
//
// Every flag can also be set through an ATHANOR_* environment variable
// (--public-url becomes ATHANOR_PUBLIC_URL), which is how container
// platforms without a command line prefer to configure a process. A flag
// given on the command line wins over the environment.
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

// version is stamped by the build (-ldflags "-X main.version=...").
var version = "dev"

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
	n := flag.Int("n", def.N, "replicas per object (N); a persisted cluster policy overrides this")
	w := flag.Int("w", def.W, "write acks before success (W)")
	r := flag.Int("r", def.R, "replicas read before answering (R)")
	vnodes := flag.Int("vnodes", ring.DefaultVNodes, "virtual nodes per physical node")
	scrub := flag.Duration("scrub-interval", 30*time.Second, "how often every local checksum is re-verified")
	reap := flag.Duration("reap-after", 2*time.Minute, "how long a dead node stays in the ring before its keys are re-replicated")
	rate := flag.Float64("rebalance-rate", 20, "rebalance copies per second")
	maxUpload := flag.Int64("max-upload-mib", api.DefaultMaxUpload>>20, "largest object accepted, in MiB")
	maxInflight := flag.Int("max-inflight", api.DefaultMaxInflight, "object bodies held in memory at once; more get 503 + Retry-After")
	shutdown := flag.Duration("shutdown-timeout", 10*time.Second, "how long to drain HTTP on SIGTERM before exiting")
	serveUI := flag.Bool("ui", true, "serve the embedded dashboard at / and /app when the binary was built with it")
	showVersion := flag.Bool("version", false, "print the version and exit")
	applyEnv()
	flag.Parse()

	if *showVersion {
		fmt.Println("vault-node", version)
		return
	}
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

	opts := api.Options{MaxUpload: *maxUpload << 20, MaxInflight: *maxInflight, Version: version}
	if *serveUI {
		if h, ok := webui.Handler(); ok {
			opts.UI = h
		}
	}
	server := &http.Server{
		Addr:    *httpAddr,
		Handler: api.NewServer(nd, opts).Handler(),
		// Slowloris protection on headers; generous bodies for 64 MiB
		// uploads and downloads over slow links; idle keep-alives reaped.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      3 * time.Minute,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}

	// Bind before joining so a port clash is reported before the node has
	// announced itself to the cluster.
	lis, err := net.Listen("tcp", *httpAddr)
	if err != nil {
		log.Fatalf("http listen %s: %v", *httpAddr, err)
	}
	if err := nd.Start(); err != nil {
		log.Fatal(err)
	}
	log.Printf("vault-node %s id=%s http=%s grpc=%s gossip=%s data=%s quorum=%s ui=%v",
		version, *id, *httpAddr, *grpcAddr, *gossipAddr, *dataDir, nd.Quorum(), opts.UI != nil)

	go func() {
		if err := server.Serve(lis); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	got := <-sig
	log.Printf("%s: draining for up to %s", got, *shutdown)
	ctx, cancel := context.WithTimeout(context.Background(), *shutdown)
	defer cancel()
	_ = server.Shutdown(ctx)
	if err := nd.Close(); err != nil {
		log.Printf("close: %v", err)
	}
}

// applyEnv seeds each flag's default from ATHANOR_<NAME> when set, so
// `--public-url` can come from ATHANOR_PUBLIC_URL and so on. Explicit flags
// still override, because flag.Parse runs afterwards.
func applyEnv() {
	flag.VisitAll(func(f *flag.Flag) {
		name := "ATHANOR_" + strings.ToUpper(strings.ReplaceAll(f.Name, "-", "_"))
		if v, ok := os.LookupEnv(name); ok && v != "" {
			if err := f.Value.Set(v); err != nil {
				log.Fatalf("%s=%q: %v", name, v, err)
			}
		}
	})
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
