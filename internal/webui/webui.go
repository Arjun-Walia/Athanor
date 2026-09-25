// Package webui serves the built dashboard and landing page from the node
// binary, so `docker compose up` needs no separate web server.
//
// `make ui-embed` (and the Dockerfile) copy ui/dist here before `go build`.
// Without that step the directory holds only a placeholder, and Handler
// reports that no UI is available.
package webui

import (
	"embed"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

func init() {
	// Go's table does not know the web manifest extension; without this the
	// file would be served as an octet stream and browsers would ignore it.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

//go:embed all:dist
var dist embed.FS

// policy is the content security policy for the pages. The dashboard talks
// to other nodes' public URLs from the browser, so connections are open;
// everything else must come from the node that served the page.
// Cloudflare injects its Web Analytics beacon into pages served through
// the tunnel; without the allowance every page load logs a CSP violation.
const policy = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; " +
	"style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
	"connect-src *; frame-ancestors 'none'; base-uri 'self'"

// Handler serves the UI, falling back to index.html for client-side routes
// such as /app. ok is false when the binary was built without a UI.
func Handler() (h http.Handler, ok bool) {
	root, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, false
	}
	index, err := fs.ReadFile(root, "index.html")
	if err != nil {
		return nil, false
	}
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", policy)
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("X-Content-Type-Options", "nosniff")
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if st, err := fs.Stat(root, name); err == nil && !st.IsDir() {
				switch {
				case strings.HasPrefix(name, "assets/"):
					// Vite hashes asset names, so they can be cached forever.
					h.Set("Cache-Control", "public, max-age=31536000, immutable")
				default:
					// Icons, the social image, robots and the sitemap change
					// rarely and are fetched by crawlers: a day is plenty.
					h.Set("Cache-Control", "public, max-age=86400")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		h.Set("Content-Type", "text/html; charset=utf-8")
		h.Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	}), true
}
