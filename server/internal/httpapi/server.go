// Package httpapi wires the CloudAIr HTTP surface: agent-facing site
// endpoints (llms.txt, page mirrors, MCP), the JWT-authenticated dashboard
// API, and internal cron endpoints.
package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/PradSharma554/CloudAIr/server/internal/agents"
	"github.com/PradSharma554/CloudAIr/server/internal/analytics"
	"github.com/PradSharma554/CloudAIr/server/internal/config"
	"github.com/PradSharma554/CloudAIr/server/internal/crawler"
	"github.com/PradSharma554/CloudAIr/server/internal/llm"
	"github.com/PradSharma554/CloudAIr/server/internal/llmstxt"
	"github.com/PradSharma554/CloudAIr/server/internal/mcpserver"
	"github.com/PradSharma554/CloudAIr/server/internal/ratelimit"
	"github.com/PradSharma554/CloudAIr/server/internal/store"
	"github.com/PradSharma554/CloudAIr/server/internal/verify"
)

type Server struct {
	cfg        *config.Config
	st         *store.Store
	verifier   *verify.Verifier
	crawler    *crawler.Crawler
	generator  *llmstxt.Generator
	llm        *llm.Client
	mcp        *mcpserver.Manager
	classifier *agents.Classifier
	limiter    ratelimit.Limiter
	rules      *ratelimit.RuleSource
	recorder   *analytics.Recorder
	sites      *siteCache
	resolver   SiteResolver
}

func NewServer(
	cfg *config.Config,
	st *store.Store,
	verifier *verify.Verifier,
	cr *crawler.Crawler,
	gen *llmstxt.Generator,
	llmClient *llm.Client,
	mcpMgr *mcpserver.Manager,
	classifier *agents.Classifier,
	limiter ratelimit.Limiter,
	rules *ratelimit.RuleSource,
	recorder *analytics.Recorder,
) *Server {
	s := &Server{
		cfg: cfg, st: st, verifier: verifier, crawler: cr, generator: gen,
		llm: llmClient, mcp: mcpMgr, classifier: classifier,
		limiter: limiter, rules: rules, recorder: recorder,
	}
	s.sites = newSiteCache(st)
	s.resolver = ChainResolver{
		&HostResolver{sites: s.sites, suffix: cfg.HostSuffix},
		&PathResolver{sites: s.sites},
	}
	return s
}

// Handler returns the root http.Handler: a resolver step (which also
// canonicalizes Host-based requests onto /sites/{slug} paths) in front of the
// chi router.
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", s.handleHealthz)

	// Agent-facing site endpoints share the full middleware chain:
	// resolve → identify → rate limit → record → paywall → handler.
	r.Route("/sites/{slug}", func(r chi.Router) {
		r.Use(s.siteCtx)
		r.Use(s.agentIdentify)
		r.Use(s.rateLimit)
		r.Use(s.record)
		r.Use(s.paywall)
		r.Get("/llms.txt", s.handleLLMSTxt)
		r.Get("/llms-full.txt", s.handleLLMSFullTxt)
		r.Get("/pages/*", s.handlePageMirror)
		r.HandleFunc("/mcp", s.handleMCP)
	})

	// Dashboard API (called by the Next.js proxy with a minted JWT).
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Post("/sites", s.apiCreateSite)
		r.Get("/sites", s.apiListSites)
		r.Route("/sites/{slug}", func(r chi.Router) {
			r.Use(s.ownedSiteCtx)
			r.Get("/", s.apiGetSite)
			r.Delete("/", s.apiDeleteSite)
			r.Post("/verify", s.apiVerifySite)
			r.Post("/crawls", s.apiStartCrawl)
			r.Get("/crawls/latest", s.apiLatestCrawl)
			r.Get("/llms-txt", s.apiGetLLMSTxt)
			r.Get("/rate-limits", s.apiGetRateLimits)
			r.Put("/rate-limits", s.apiPutRateLimits)
			r.Put("/settings", s.apiPutSettings)
			r.Get("/analytics/timeseries", s.apiAnalyticsTimeseries)
			r.Get("/analytics/top", s.apiAnalyticsTop)
		})
	})

	// Internal endpoints for the GitHub Actions cron.
	r.Post("/internal/recrawl", s.handleInternalRecrawl)

	return s.hostRewrite(r)
}

// hostRewrite canonicalizes Host-resolved requests (<slug>.cloudair.dev/mcp)
// onto the path form (/sites/<slug>/mcp) so one router serves both modes.
func (s *Server) hostRewrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.HostSuffix != "" {
			if site, rest, ok := (&HostResolver{sites: s.sites, suffix: s.cfg.HostSuffix}).Resolve(r); ok {
				r = withSite(r, site)
				r.URL.Path = "/sites/" + site.Slug + rest
			}
		}
		next.ServeHTTP(w, r)
	})
}

// siteCtx resolves the site for agent-facing routes (context first — set by
// hostRewrite — then the resolver chain) and 404s unverified sites.
func (s *Server) siteCtx(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		site := siteFrom(r)
		if site == nil {
			var ok bool
			site, _, ok = s.resolver.Resolve(r)
			if !ok {
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "site not found"})
				return
			}
			r = withSite(r, site)
		}
		if site.VerifiedAt == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "site not verified"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
