package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The repository ships only a placeholder in dist; the embedded UI is
// produced by `make ui-embed`. Either way the handler must be consistent.
func TestHandlerServesIndexForClientRoutesWhenBuilt(t *testing.T) {
	h, ok := Handler()
	if !ok {
		t.Skip("binary built without the UI (run make ui-embed)")
	}
	for _, p := range []string{"/", "/app", "/app/objects", "/no/such/file"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `<div id="root">`) {
			t.Fatalf("%s: %d %q", p, rec.Code, rec.Body.String()[:min(80, rec.Body.Len())])
		}
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "connect-src *") {
			t.Fatalf("%s: missing CSP", p)
		}
		if rec.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: index must not be cached, got %q", p, rec.Header().Get("Cache-Control"))
		}
	}
}

// Crawler-facing files ship next to the app and must be served as what
// they are, not as index.html and not as octet streams.
func TestHandlerServesPublicAssetsWithTheirTypes(t *testing.T) {
	h, ok := Handler()
	if !ok {
		t.Skip("binary built without the UI (run make ui-embed)")
	}
	cases := map[string]string{
		"/robots.txt":       "text/plain",
		"/sitemap.xml":      "xml",
		"/site.webmanifest": "application/manifest+json",
		"/og.jpg":           "image/jpeg",
		"/favicon.svg":      "image/svg+xml",
	}
	for p, want := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: %d", p, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, want) {
			t.Fatalf("%s: content type %q, want %q", p, ct, want)
		}
		if strings.Contains(rec.Body.String(), `<div id="root">`) {
			t.Fatalf("%s fell through to index.html", p)
		}
	}
}
