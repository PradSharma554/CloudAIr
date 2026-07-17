package httpapi

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

func (s *Server) handleLLMSTxt(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	if site.LLMSTxt == "" {
		http.Error(w, "llms.txt not generated yet — crawl in progress or not started", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	fmt.Fprint(w, site.LLMSTxt)
}

// handleLLMSFullTxt streams every page's markdown so a 50-page site never
// sits in memory at once.
func (s *Server) handleLLMSFullTxt(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	fmt.Fprintf(w, "# %s\n\n", site.Domain)
	flusher, _ := w.(http.Flusher)
	err := s.st.IteratePagesFull(r.Context(), site.ID, func(p *store.Page) error {
		title := p.Title
		if title == "" {
			title = p.Path
		}
		if _, err := fmt.Fprintf(w, "## %s\n\nURL: %s\n\n%s\n\n---\n\n", title, p.URL, p.Markdown); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	})
	if err != nil {
		// Headers already sent; just stop streaming.
		return
	}
}

func (s *Server) handlePageMirror(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	path := "/" + strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	page, err := s.st.GetPageByPath(r.Context(), site.ID, path)
	if err == store.ErrNotFound {
		http.Error(w, "page not found — see /sites/"+site.Slug+"/llms.txt for the index", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	fmt.Fprintf(w, "# %s\n\nSource: %s\n\n%s\n", page.Title, page.URL, page.Markdown)
}

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	s.mcp.Handler(siteFrom(r)).ServeHTTP(w, r)
}
