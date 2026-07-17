package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

// SiteResolver extracts the target site from a request. This is the seam
// that makes reverse-proxy mode an add-on instead of a rewrite: handlers
// never parse URLs for the site — they read it from context, and resolvers
// decide how a request maps to a site (path today, Host header later).
type SiteResolver interface {
	// Resolve returns the site, the remaining path ("/llms.txt", "/mcp"),
	// and whether this resolver matched.
	Resolve(r *http.Request) (site *store.Site, rest string, ok bool)
}

// siteCache is a small TTL cache so hot sites don't hit Postgres per request.
type siteCache struct {
	st    *store.Store
	cache *expirable.LRU[string, *store.Site]
}

func newSiteCache(st *store.Store) *siteCache {
	return &siteCache{
		st:    st,
		cache: expirable.NewLRU[string, *store.Site](1024, nil, 30*time.Second),
	}
}

func (c *siteCache) bySlug(r *http.Request, slug string) *store.Site {
	if site, ok := c.cache.Get(slug); ok {
		return site
	}
	site, err := c.st.GetSiteBySlug(r.Context(), slug)
	if err != nil {
		return nil
	}
	c.cache.Add(slug, site)
	return site
}

func (c *siteCache) invalidate(slug string) {
	c.cache.Remove(slug)
}

// PathResolver matches /sites/{slug}/... — the MVP hosted-endpoints mode.
type PathResolver struct {
	sites *siteCache
}

func (p *PathResolver) Resolve(r *http.Request) (*store.Site, string, bool) {
	path := strings.TrimPrefix(r.URL.Path, "/sites/")
	if path == r.URL.Path {
		return nil, "", false
	}
	slug, rest, _ := strings.Cut(path, "/")
	if slug == "" {
		return nil, "", false
	}
	site := p.sites.bySlug(r, slug)
	if site == nil {
		return nil, "", false
	}
	return site, "/" + rest, true
}

// HostResolver matches <slug><suffix> hosts (e.g. example-com.cloudair.dev).
// Enabled by setting HOST_SUFFIX; the first step toward reverse-proxy mode.
type HostResolver struct {
	sites  *siteCache
	suffix string // e.g. ".cloudair.dev"
}

func (h *HostResolver) Resolve(r *http.Request) (*store.Site, string, bool) {
	if h.suffix == "" {
		return nil, "", false
	}
	host := r.Host
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	slug, found := strings.CutSuffix(strings.ToLower(host), h.suffix)
	if !found || slug == "" || strings.Contains(slug, ".") {
		return nil, "", false
	}
	site := h.sites.bySlug(r, slug)
	if site == nil {
		return nil, "", false
	}
	return site, r.URL.Path, true
}

// ChainResolver tries resolvers in order (Host first, path fallback).
type ChainResolver []SiteResolver

func (c ChainResolver) Resolve(r *http.Request) (*store.Site, string, bool) {
	for _, res := range c {
		if site, rest, ok := res.Resolve(r); ok {
			return site, rest, ok
		}
	}
	return nil, "", false
}
