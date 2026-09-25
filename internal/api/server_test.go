package api

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/Arjun-Walia/Athanor/internal/node"
	"github.com/Arjun-Walia/Athanor/internal/replica"
)

func port(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
}

// single starts a one-node cluster (N=W=R=1) behind the real HTTP handler.
func single(t *testing.T) (*node.Node, *httptest.Server) {
	t.Helper()
	n, err := node.New(node.Config{
		ID:         "node1",
		DataDir:    t.TempDir(),
		HTTPAddr:   "127.0.0.1:" + port(t),
		GRPCAddr:   "127.0.0.1:" + port(t),
		GossipAddr: "127.0.0.1:" + port(t),
		Quorum:     replica.Quorum{N: 1, W: 1, R: 1},
		Fast:       true,
		Quiet:      true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := n.Start(); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(NewServer(n, Options{}).Handler())
	t.Cleanup(func() {
		srv.Close()
		_ = n.Close()
	})
	return n, srv
}

func do(t *testing.T, method, url, body string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

func decode(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return body
}

func TestHealth(t *testing.T) {
	_, srv := single(t)
	resp, raw := do(t, http.MethodGet, srv.URL+"/v1/admin/health", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	body := decode(t, raw)
	if body["status"] != "ok" || body["node_id"] != "node1" || body["mode"] != Mode || body["state"] != "running" {
		t.Fatalf("health = %#v", body)
	}
}

func TestObjectRoundTrip(t *testing.T) {
	_, srv := single(t)
	resp, raw := do(t, http.MethodPut, srv.URL+"/v1/objects/reports/q3.txt", "hello athanor")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("put = %d %s", resp.StatusCode, raw)
	}
	put := decode(t, raw)
	if put["key"] != "reports/q3.txt" || put["checksum"] == "" {
		t.Fatalf("put body = %#v", put)
	}

	resp, raw = do(t, http.MethodGet, srv.URL+"/v1/objects/reports/q3.txt", "")
	if resp.StatusCode != http.StatusOK || string(raw) != "hello athanor" {
		t.Fatalf("get = %d %q", resp.StatusCode, raw)
	}
	if resp.Header.Get("X-Athanor-Checksum") != put["checksum"] {
		t.Fatalf("checksum header = %q", resp.Header.Get("X-Athanor-Checksum"))
	}
	if resp.Header.Get("X-Athanor-Version") != put["version"] {
		t.Fatalf("version header = %q, put said %v", resp.Header.Get("X-Athanor-Version"), put["version"])
	}

	resp, _ = do(t, http.MethodDelete, srv.URL+"/v1/objects/reports/q3.txt", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d", resp.StatusCode)
	}
	resp, raw = do(t, http.MethodGet, srv.URL+"/v1/objects/reports/q3.txt", "")
	if resp.StatusCode != http.StatusNotFound || decode(t, raw)["deleted"] != true {
		t.Fatalf("get after delete = %d %s", resp.StatusCode, raw)
	}
}

func TestOverviewShowsReplicaMap(t *testing.T) {
	_, srv := single(t)
	do(t, http.MethodPut, srv.URL+"/v1/objects/a", "aaa")
	resp, raw := do(t, http.MethodGet, srv.URL+"/v1/admin/overview", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("overview = %d %s", resp.StatusCode, raw)
	}
	var ov node.Overview
	if err := json.Unmarshal(raw, &ov); err != nil {
		t.Fatal(err)
	}
	if len(ov.Objects) != 1 || ov.Objects[0].Key != "a" || ov.Objects[0].Healthy != 1 {
		t.Fatalf("objects = %+v", ov.Objects)
	}
	if len(ov.Nodes) != 1 || !ov.Nodes[0].Self {
		t.Fatalf("nodes = %+v", ov.Nodes)
	}
}

func TestStoppedNodeRefusesDataButKeepsAdmin(t *testing.T) {
	_, srv := single(t)
	resp, raw := do(t, http.MethodPost, srv.URL+"/v1/admin/fault/stop", "")
	if resp.StatusCode != http.StatusOK || decode(t, raw)["state"] != "stopped" {
		t.Fatalf("stop = %d %s", resp.StatusCode, raw)
	}
	resp, _ = do(t, http.MethodPut, srv.URL+"/v1/objects/x", "x")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("put while stopped = %d", resp.StatusCode)
	}
	_, raw = do(t, http.MethodGet, srv.URL+"/v1/admin/health", "")
	if decode(t, raw)["state"] != "stopped" {
		t.Fatalf("health while stopped = %s", raw)
	}
	resp, raw = do(t, http.MethodPost, srv.URL+"/v1/admin/nodes/node1/start", "")
	if resp.StatusCode != http.StatusOK || decode(t, raw)["state"] != "running" {
		t.Fatalf("start = %d %s", resp.StatusCode, raw)
	}
	resp, _ = do(t, http.MethodPut, srv.URL+"/v1/objects/x", "x")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("put after restart = %d", resp.StatusCode)
	}
}

func TestConfigValidation(t *testing.T) {
	_, srv := single(t)
	resp, _ := do(t, http.MethodPut, srv.URL+"/v1/admin/config", `{"n":1,"w":2,"r":1}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("w > n accepted: %d", resp.StatusCode)
	}
	resp, raw := do(t, http.MethodPut, srv.URL+"/v1/admin/config", `{"n":1,"w":1,"r":1}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("valid config = %d %s", resp.StatusCode, raw)
	}
}

func TestCorruptThenScrubHeals(t *testing.T) {
	n, srv := single(t)
	do(t, http.MethodPut, srv.URL+"/v1/objects/k", "precious")
	resp, raw := do(t, http.MethodPost, srv.URL+"/v1/admin/corrupt", `{"key":"k","node":"node1"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("corrupt = %d %s", resp.StatusCode, raw)
	}
	// One node, one replica: scrub finds the flip but has nothing healthy to
	// heal from, and says so rather than pretending.
	resp, raw = do(t, http.MethodPost, srv.URL+"/v1/admin/scrub", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("scrub = %d %s", resp.StatusCode, raw)
	}
	if ev, ok := n.Log().Last("repair"); !ok || ev.Level != "error" {
		t.Fatalf("expected a data-loss repair event, got %+v", ev)
	}
}

func TestCORSPreflight(t *testing.T) {
	_, srv := single(t)
	resp, _ := do(t, http.MethodOptions, srv.URL+"/v1/objects/report.pdf", "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow origin = %q", got)
	}
	if !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), "X-Athanor-Version") {
		t.Fatal("version header not exposed to the browser")
	}
}
