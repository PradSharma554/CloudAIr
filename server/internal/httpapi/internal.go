package httpapi

import (
	"crypto/subtle"
	"log/slog"
	"net/http"
)

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	dbStatus := "ok"
	if err := s.st.Health(r.Context()); err != nil {
		dbStatus = "error: " + err.Error()
	}
	size, _ := s.st.DBSizeBytes(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{
		"status":               "ok",
		"db":                   dbStatus,
		"db_size_bytes":        size,
		"gemini_enabled":       s.llm.Enabled(),
		"gemini_calls":         s.llm.Calls(),
		"analytics_drop_count": s.recorder.Dropped(),
	})
}

// handleInternalRecrawl is hit by the GitHub Actions cron: resume stalled
// crawls, recrawl every verified site, roll up analytics, prune old events.
func (s *Server) handleInternalRecrawl(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Internal-Token")
	if s.cfg.InternalToken == "" ||
		subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.InternalToken)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	if err := s.crawler.ResumeStalled(r.Context()); err != nil {
		slog.Error("resume stalled crawls failed", "err", err)
	}

	sitesList, err := s.st.ListVerifiedSites(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "site list failed"})
		return
	}
	started := 0
	for _, site := range sitesList {
		if _, err := s.crawler.Start(r.Context(), site); err == nil {
			started++
		}
	}

	rollupStatus := "ok"
	if err := s.st.RollupAndPrune(r.Context()); err != nil {
		slog.Error("rollup failed", "err", err)
		rollupStatus = err.Error()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"sites":          len(sitesList),
		"crawls_started": started,
		"rollup":         rollupStatus,
	})
}
