package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/PradSharma554/CloudAIr/server/internal/sites"
	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

// ownedSiteCtx loads the site by slug and enforces ownership (404 either way
// so slugs can't be probed).
func (s *Server) ownedSiteCtx(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		site, err := s.st.GetSiteBySlug(r.Context(), chi.URLParam(r, "slug"))
		if err != nil || site.UserID != userIDFrom(r) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "site not found"})
			return
		}
		next.ServeHTTP(w, withSite(r, site))
	})
}

func (s *Server) apiCreateSite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Domain string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	domain, err := sites.NormalizeDomain(in.Domain)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	token, err := sites.NewVerificationToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "token generation failed"})
		return
	}
	site, err := s.st.CreateSite(r.Context(), userIDFrom(r), domain, sites.Slug(domain), token)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "domain already registered"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "create failed"})
		return
	}
	writeJSON(w, http.StatusCreated, s.siteJSON(site, nil))
}

func (s *Server) apiListSites(w http.ResponseWriter, r *http.Request) {
	list, err := s.st.ListSitesByUser(r.Context(), userIDFrom(r))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "list failed"})
		return
	}
	out := make([]map[string]any, 0, len(list))
	for _, site := range list {
		out = append(out, s.siteJSON(site, nil))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sites": out})
}

func (s *Server) apiGetSite(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	crawl, err := s.st.LatestCrawl(r.Context(), site.ID)
	if err != nil && err != store.ErrNotFound {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "crawl lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, s.siteJSON(site, crawl))
}

func (s *Server) apiDeleteSite(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	if err := s.st.DeleteSite(r.Context(), site.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "delete failed"})
		return
	}
	s.sites.invalidate(site.Slug)
	s.mcp.Invalidate(site.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) apiVerifySite(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	if site.VerifiedAt != nil {
		writeJSON(w, http.StatusOK, map[string]any{"verified": true, "method": site.VerificationMethod})
		return
	}
	method, err := s.verifier.Check(r.Context(), site.Domain, site.VerificationToken)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"verified": false, "detail": err.Error()})
		return
	}
	if err := s.st.MarkSiteVerified(r.Context(), site.ID, method); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "verification save failed"})
		return
	}
	s.sites.invalidate(site.Slug)
	// Kick off the first crawl right away — the wizard's next step.
	if _, err := s.crawler.Start(r.Context(), site); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"verified": true, "method": method, "crawl_started": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": true, "method": method, "crawl_started": true})
}

func (s *Server) apiStartCrawl(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	if site.VerifiedAt == nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "verify the site first"})
		return
	}
	crawl, err := s.crawler.Start(r.Context(), site)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, crawl)
}

func (s *Server) apiLatestCrawl(w http.ResponseWriter, r *http.Request) {
	crawl, err := s.st.LatestCrawl(r.Context(), siteFrom(r).ID)
	if err == store.ErrNotFound {
		writeJSON(w, http.StatusOK, map[string]any{"crawl": nil})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"crawl": crawl})
}

func (s *Server) apiGetLLMSTxt(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"llms_txt":     site.LLMSTxt,
		"generated_at": site.LLMSTxtGeneratedAt,
		"public_url":   s.cfg.PublicBaseURL + "/sites/" + site.Slug + "/llms.txt",
		"mcp_url":      s.cfg.PublicBaseURL + "/sites/" + site.Slug + "/mcp",
	})
}

func (s *Server) apiGetRateLimits(w http.ResponseWriter, r *http.Request) {
	rules, err := s.st.ListRateLimitRules(r.Context(), siteFrom(r).ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

func (s *Server) apiPutRateLimits(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	var in struct {
		Rules []store.RateLimitRule `json:"rules"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	for _, rule := range in.Rules {
		if rule.SubjectType != "class" && rule.SubjectType != "agent" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "subject_type must be 'class' or 'agent'"})
			return
		}
		if rule.Subject == "" || rule.RPM < 1 || rule.RPM > 100000 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "subject required and rpm must be 1-100000"})
			return
		}
	}
	if err := s.st.ReplaceRateLimitRules(r.Context(), site.ID, in.Rules); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save failed"})
		return
	}
	s.rules.Invalidate(site.ID)
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

func (s *Server) apiPutSettings(w http.ResponseWriter, r *http.Request) {
	site := siteFrom(r)
	var in store.SiteSettings
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if err := s.st.UpdateSiteSettings(r.Context(), site.ID, in); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "save failed"})
		return
	}
	s.sites.invalidate(site.Slug)
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

func (s *Server) apiAnalyticsTimeseries(w http.ResponseWriter, r *http.Request) {
	since, bucket := rangeParams(r)
	points, err := s.st.AnalyticsTimeseries(r.Context(), siteFrom(r).ID, since, bucket)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"points": points})
}

func (s *Server) apiAnalyticsTop(w http.ResponseWriter, r *http.Request) {
	since, _ := rangeParams(r)
	by := r.URL.Query().Get("by")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.st.AnalyticsTop(r.Context(), siteFrom(r).ID, by, since, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "query failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

// rangeParams parses ?range=24h|7d|30d and ?bucket=hour|day with sane defaults.
func rangeParams(r *http.Request) (time.Time, string) {
	now := time.Now()
	bucket := r.URL.Query().Get("bucket")
	switch r.URL.Query().Get("range") {
	case "24h":
		if bucket == "" {
			bucket = "hour"
		}
		return now.Add(-24 * time.Hour), bucket
	case "30d":
		if bucket == "" {
			bucket = "day"
		}
		return now.AddDate(0, 0, -30), bucket
	default:
		if bucket == "" {
			bucket = "day"
		}
		return now.AddDate(0, 0, -7), bucket
	}
}

func (s *Server) siteJSON(site *store.Site, crawl *store.Crawl) map[string]any {
	out := map[string]any{
		"id":                  site.ID,
		"domain":              site.Domain,
		"slug":                site.Slug,
		"verified":            site.VerifiedAt != nil,
		"verification_method": site.VerificationMethod,
		"verification_token":  site.VerificationToken,
		"dns_record_host":     "_cloudair." + site.Domain,
		"well_known_url":      "https://" + site.Domain + "/.well-known/cloudair-verify.txt",
		"llms_txt_url":        s.cfg.PublicBaseURL + "/sites/" + site.Slug + "/llms.txt",
		"llms_full_txt_url":   s.cfg.PublicBaseURL + "/sites/" + site.Slug + "/llms-full.txt",
		"mcp_url":             s.cfg.PublicBaseURL + "/sites/" + site.Slug + "/mcp",
		"llms_txt_generated":  site.LLMSTxtGeneratedAt != nil,
		"settings":            site.Settings,
		"created_at":          site.CreatedAt,
	}
	if crawl != nil {
		out["latest_crawl"] = crawl
	}
	return out
}
