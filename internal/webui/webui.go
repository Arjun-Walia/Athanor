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
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

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
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if st, err := fs.Stat(root, name); err == nil && !st.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(index)
	}), true
}
