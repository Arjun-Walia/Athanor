package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Arjun-Walia/Athanor/internal/replica"
)

func testServer() *Server {
	return NewServer(Config{
		NodeID:   "node1",
		HTTPAddr: ":8080",
		GRPCAddr: ":9090",
		Seeds:    []string{"node2", "node3"},
		Quorum:   replica.DefaultQuorum(),
	})
}

func decode(t *testing.T, rr *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %s: %v", rr.Body.String(), err)
	}
	return body
}

func TestHealth(t *testing.T) {
	rr := httptest.NewRecorder()
	testServer().Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/admin/health", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	body := decode(t, rr)
	if body["status"] != "ok" || body["node_id"] != "node1" || body["mode"] != Mode {
		t.Fatalf("health = %#v", body)
	}
	quorum, _ := body["quorum"].(map[string]any)
	if quorum["n"] != float64(3) || quorum["w"] != float64(2) || quorum["r"] != float64(2) {
		t.Fatalf("quorum = %#v", quorum)
	}
}

func TestClusterIsLocalOnly(t *testing.T) {
	rr := httptest.NewRecorder()
	testServer().Handler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/admin/cluster", nil))
	body := decode(t, rr)
	if body["implemented"] != false {
		t.Fatal("cluster must not claim membership is implemented")
	}
	if body["ring_version"] != float64(0) {
		t.Fatalf("ring_version = %#v", body["ring_version"])
	}
}

func TestObjectRoutesNotImplemented(t *testing.T) {
	srv := testServer().Handler()
	for _, method := range []string{http.MethodPut, http.MethodGet, http.MethodDelete} {
		rr := httptest.NewRecorder()
		srv.ServeHTTP(rr, httptest.NewRequest(method, "/v1/objects/report.pdf", nil))
		if rr.Code != http.StatusNotImplemented {
			t.Fatalf("%s status = %d", method, rr.Code)
		}
		body := decode(t, rr)
		if body["key"] != "report.pdf" || body["phase"] != "A" {
			t.Fatalf("%s body = %#v", method, body)
		}
	}
}

func TestCORSPreflight(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/v1/objects/report.pdf", nil)
	testServer().Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status = %d", rr.Code)
	}
	if got := rr.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("allow origin = %q", got)
	}
}
