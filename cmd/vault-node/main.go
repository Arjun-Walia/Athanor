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
	"log/slog"
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

// settings is everything the flags and ATHANOR_* environment decide.
type settings struct {
	id, httpAddr, grpcAddr, gossipAddr, advertise, publicURL, dataDir, seeds string
	quorum                                                                   replica.Quorum
	vnodes                                                                   int
	scrub, reap, shutdown                                                    time.Duration
	rate                                                                     float64
	maxUploadMiB                                                             int64
	maxInflight                                                              int
	serveUI, showVersion                                                     bool
	adminToken, clusterSecret, tlsCert, tlsKey                               string
}

func parseFlags(args []string) (settings, error) {
	def := replica.DefaultQuorum()
	var s settings
	fs := flag.NewFlagSet("vault-node", flag.ContinueOnError)
	fs.StringVar(&s.id, "id", "node1", "node id (letters, digits, . _ -)")
	fs.StringVar(&s.httpAddr, "http", ":8080", "client and admin HTTP listen address")
	fs.StringVar(&s.grpcAddr, "grpc", ":9090", "peer gRPC listen address")
	fs.StringVar(&s.gossipAddr, "gossip", "0.0.0.0:7946", "memberlist (SWIM) bind address")
	fs.StringVar(&s.advertise, "advertise", "", "host other nodes use to reach this one (default: the gossip IP)")
	fs.StringVar(&s.publicURL, "public-url", "", "browser-facing URL of this node's HTTP API (default: http://localhost:<http port>)")
	fs.StringVar(&s.dataDir, "data", "./data", "local blob and index directory")
	fs.StringVar(&s.seeds, "seeds", "", "comma-separated gossip seeds, host or host:port (port defaults to 7946)")
	fs.IntVar(&s.quorum.N, "n", def.N, "replicas per object (N); a persisted cluster policy overrides this")
	fs.IntVar(&s.quorum.W, "w", def.W, "write acks before success (W)")
	fs.IntVar(&s.quorum.R, "r", def.R, "replicas read before answering (R)")
	fs.IntVar(&s.vnodes, "vnodes", ring.DefaultVNodes, "virtual nodes per physical node")
	fs.DurationVar(&s.scrub, "scrub-interval", 30*time.Second, "how often every local checksum is re-verified")
	fs.DurationVar(&s.reap, "reap-after", 2*time.Minute, "how long a dead node stays in the ring before its keys are re-replicated")
	fs.Float64Var(&s.rate, "rebalance-rate", 20, "rebalance copies per second")
	fs.Int64Var(&s.maxUploadMiB, "max-upload-mib", api.DefaultMaxUpload>>20, "largest object accepted, in MiB")
	fs.IntVar(&s.maxInflight, "max-inflight", api.DefaultMaxInflight, "object bodies held in memory at once; more get 503 + Retry-After")
	fs.DurationVar(&s.shutdown, "shutdown-timeout", 10*time.Second, "how long to drain HTTP on SIGTERM before exiting")
	fs.BoolVar(&s.serveUI, "ui", true, "serve the embedded dashboard at / and /app when the binary was built with it")
	fs.StringVar(&s.adminToken, "admin-token", "", "bearer token required for writes and admin actions (empty: open, for local demos)")
	fs.StringVar(&s.clusterSecret, "cluster-secret", "", "shared secret that encrypts gossip and authenticates peer RPC (empty: open)")
	fs.StringVar(&s.tlsCert, "tls-cert", "", "serve HTTPS with this certificate (PEM); needs --tls-key")
	fs.StringVar(&s.tlsKey, "tls-key", "", "private key (PEM) for --tls-cert")
	fs.BoolVar(&s.showVersion, "version", false, "print the version and exit")
	if err := applyEnv(fs, os.LookupEnv); err != nil {
		return s, err
	}
	if err := fs.Parse(args); err != nil {
		return s, err
	}
	return s, s.validate()
}

func (s *settings) validate() error {
	if !validID.MatchString(s.id) {
		return fmt.Errorf("invalid --id %q", s.id)
	}
	if err := s.quorum.Validate(); err != nil {
		return fmt.Errorf("invalid quorum: %w", err)
	}
	if (s.tlsCert == "") != (s.tlsKey == "") {
		return errors.New("--tls-cert and --tls-key go together")
	}
	if s.publicURL == "" {
		if _, port, err := net.SplitHostPort(s.httpAddr); err == nil {
			scheme := "http"
			if s.tlsCert != "" {
				scheme = "https"
			}
			s.publicURL = scheme + "://localhost:" + port
		}
	}
	return nil
}

// isLocal reports whether a public URL points at this machine only.
func isLocal(publicURL string) bool {
	return strings.Contains(publicURL, "localhost") || strings.Contains(publicURL, "127.0.0.1")
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	s, err := parseFlags(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fatal("bad configuration", "err", err)
	}
	if s.showVersion {
		fmt.Println("vault-node", version)
		return
	}
	if err := run(s); err != nil {
		fatal("vault-node stopped", "err", err)
	}
}

func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

// run starts one node and blocks until SIGINT or SIGTERM.
func run(s settings) error {
	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return fmt.Errorf("data dir: %w", err)
	}
	nd, err := node.New(node.Config{
		ID:            s.id,
		DataDir:       s.dataDir,
		HTTPAddr:      s.httpAddr,
		GRPCAddr:      s.grpcAddr,
		GossipAddr:    s.gossipAddr,
		Advertise:     s.advertise,
		PublicURL:     s.publicURL,
		Seeds:         seedList(s.seeds),
		Quorum:        s.quorum,
		VNodes:        s.vnodes,
		ScrubInterval: s.scrub,
		ReapAfter:     s.reap,
		RebalanceRate: s.rate,
		ClusterSecret: s.clusterSecret,
	})
	if err != nil {
		return err
	}

	opts := api.Options{MaxUpload: s.maxUploadMiB << 20, MaxInflight: s.maxInflight, Version: version, AdminToken: s.adminToken}
	if s.serveUI {
		if h, ok := webui.Handler(); ok {
			opts.UI = h
		}
	}
	server := &http.Server{
		Addr:    s.httpAddr,
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
	lis, err := net.Listen("tcp", s.httpAddr)
	if err != nil {
		return fmt.Errorf("http listen %s: %w", s.httpAddr, err)
	}
	if err := nd.Start(); err != nil {
		return err
	}
	slog.Info("vault-node started",
		"version", version, "id", s.id, "http", s.httpAddr, "grpc", s.grpcAddr, "gossip", s.gossipAddr,
		"data", s.dataDir, "quorum", nd.Quorum().String(), "ui", opts.UI != nil,
		"admin_auth", s.adminToken != "", "secured", s.clusterSecret != "", "tls", s.tlsCert != "")
	if s.adminToken == "" && !isLocal(s.publicURL) {
		slog.Warn("reachable without an admin token; anyone can stop nodes and flip bytes (set --admin-token)", "public_url", s.publicURL)
	}

	serveErr := make(chan error, 1)
	go func() {
		var err error
		if s.tlsCert != "" {
			err = server.ServeTLS(lis, s.tlsCert, s.tlsKey)
		} else {
			err = server.Serve(lis)
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-serveErr:
		_ = nd.Close()
		return err
	case got := <-sig:
		slog.Info("draining", "signal", got.String(), "timeout", s.shutdown)
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.shutdown)
	defer cancel()
	_ = server.Shutdown(ctx)
	if err := nd.Close(); err != nil {
		slog.Warn("close", "err", err)
	}
	return nil
}

// applyEnv seeds each flag's default from ATHANOR_<NAME> when set, so
// `--public-url` can come from ATHANOR_PUBLIC_URL and so on. Explicit flags
// still override, because Parse runs afterwards.
func applyEnv(fs *flag.FlagSet, lookup func(string) (string, bool)) error {
	var err error
	fs.VisitAll(func(f *flag.Flag) {
		name := envName(f.Name)
		v, ok := lookup(name)
		if !ok || v == "" || err != nil {
			return
		}
		if setErr := f.Value.Set(v); setErr != nil {
			err = fmt.Errorf("%s=%q: %w", name, v, setErr)
		}
	})
	return err
}

// envName is the ATHANOR_* variable that backs a flag.
func envName(flagName string) string {
	return "ATHANOR_" + strings.ToUpper(strings.ReplaceAll(flagName, "-", "_"))
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
