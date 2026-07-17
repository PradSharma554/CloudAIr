// Package crawler implements a polite, checkpointed BFS crawler that runs as
// a goroutine inside the web service (Render free tier has no workers). After
// every page it persists progress, so a spin-down mid-crawl loses at most one
// page; a reaper resumes stalled crawls from their checkpoints on boot.
package crawler

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/temoto/robotstxt"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

const (
	userAgent    = "CloudAIrBot/1.0 (+https://github.com/PradSharma554/CloudAIr)"
	maxBodyBytes = 2 * 1024 * 1024
	crawlTimeout = 20 * time.Minute
	politeness   = 1 * time.Second
)

// PostCrawl runs after a successful crawl (llms.txt generation is wired in
// here by main, keeping this package free of llm dependencies).
type PostCrawl func(ctx context.Context, site *store.Site) error

type Crawler struct {
	st        *store.Store
	client    *http.Client
	postCrawl PostCrawl

	mu     sync.Mutex
	active map[string]bool // siteID → crawl goroutine running in this process
}

func New(st *store.Store, postCrawl PostCrawl) *Crawler {
	return &Crawler{
		st: st,
		client: &http.Client{
			Timeout: 15 * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return fmt.Errorf("too many redirects")
				}
				return nil
			},
		},
		postCrawl: postCrawl,
		active:    map[string]bool{},
	}
}

// Start begins a crawl for the site unless one is already running.
func (c *Crawler) Start(ctx context.Context, site *store.Site) (*store.Crawl, error) {
	if _, err := c.st.RunningCrawl(ctx, site.ID); err == nil {
		return nil, fmt.Errorf("crawl already running")
	}
	crawl, err := c.st.CreateCrawl(ctx, site.ID, site.MaxPages())
	if err != nil {
		return nil, err
	}
	c.launch(site, crawl)
	return crawl, nil
}

// ResumeStalled reaps crawls whose goroutine died (process restart) and
// resumes them from their checkpoints. Called on boot and from /internal.
func (c *Crawler) ResumeStalled(ctx context.Context) error {
	stalled, err := c.st.ReapStalledCrawls(ctx)
	if err != nil {
		return err
	}
	for _, crawl := range stalled {
		site, err := c.st.GetSiteByID(ctx, crawl.SiteID)
		if err != nil {
			slog.Error("cannot resume crawl, site lookup failed", "crawl", crawl.ID, "err", err)
			continue
		}
		if err := c.st.ResumeCrawl(ctx, crawl.ID); err != nil {
			continue
		}
		slog.Info("resuming stalled crawl", "site", site.Domain, "pages_done", crawl.PagesCrawled)
		c.launch(site, crawl)
	}
	return nil
}

func (c *Crawler) launch(site *store.Site, crawl *store.Crawl) {
	c.mu.Lock()
	if c.active[site.ID] {
		c.mu.Unlock()
		return
	}
	c.active[site.ID] = true
	c.mu.Unlock()

	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.active, site.ID)
			c.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), crawlTimeout)
		defer cancel()
		if err := c.run(ctx, site, crawl); err != nil {
			slog.Error("crawl failed", "site", site.Domain, "err", err)
			_ = c.st.FinishCrawl(context.Background(), crawl.ID, store.CrawlFailed, err.Error())
			return
		}
		_ = c.st.FinishCrawl(context.Background(), crawl.ID, store.CrawlCompleted, "")
		slog.Info("crawl completed", "site", site.Domain)
	}()
}

func (c *Crawler) run(ctx context.Context, site *store.Site, crawl *store.Crawl) error {
	started := time.Now()
	base := "https://" + site.Domain

	robots := c.fetchRobots(ctx, base)

	visited := map[string]bool{}
	var frontier []string
	pagesDone := crawl.PagesCrawled
	if crawl.Checkpoint != nil {
		frontier = crawl.Checkpoint.Frontier
		for _, u := range crawl.Checkpoint.Visited {
			visited[u] = true
		}
	}
	if len(frontier) == 0 && pagesDone == 0 {
		if seeds := c.fetchSitemap(ctx, base); len(seeds) > 0 {
			for _, s := range seeds {
				if u := c.normalize(site, s); u != "" && !visited[u] {
					frontier = append(frontier, u)
				}
			}
		}
		if home := c.normalize(site, base+"/"); home != "" {
			frontier = append([]string{home}, frontier...)
		}
	}

	ticker := time.NewTicker(politeness)
	defer ticker.Stop()

	for len(frontier) > 0 && pagesDone < crawl.MaxPages {
		select {
		case <-ctx.Done():
			// Timeout/shutdown: checkpoint is already persisted per page;
			// the reaper will resume this crawl.
			return ctx.Err()
		case <-ticker.C:
		}

		pageURL := frontier[0]
		frontier = frontier[1:]
		if visited[pageURL] {
			continue
		}
		visited[pageURL] = true

		if robots != nil && !robots.Test(urlPath(pageURL)) {
			continue
		}

		links, err := c.fetchPage(ctx, site, pageURL)
		if err != nil {
			slog.Debug("page fetch failed", "url", pageURL, "err", err)
		} else {
			pagesDone++
		}
		for _, link := range links {
			if u := c.normalize(site, link); u != "" && !visited[u] {
				frontier = append(frontier, u)
			}
		}
		if len(frontier) > 500 {
			frontier = frontier[:500]
		}

		cp := &store.Checkpoint{Frontier: frontier, Visited: keys(visited)}
		if err := c.st.CheckpointCrawl(ctx, crawl.ID, pagesDone, cp); err != nil {
			return fmt.Errorf("checkpoint: %w", err)
		}
	}

	if pagesDone == 0 {
		return fmt.Errorf("no pages could be crawled from %s", base)
	}

	// Remove pages that disappeared since the previous crawl.
	_ = c.st.DeleteStalePages(ctx, site.ID, started)

	if c.postCrawl != nil {
		// Summarization can take minutes at 8 RPM; keep the heartbeat alive
		// so the reaper doesn't mark this crawl stalled.
		stop := c.keepHeartbeat(ctx, crawl.ID, pagesDone)
		err := c.postCrawl(ctx, site)
		stop()
		if err != nil {
			return fmt.Errorf("post-crawl: %w", err)
		}
	}
	return nil
}

func (c *Crawler) keepHeartbeat(ctx context.Context, crawlID string, pagesDone int) func() {
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				_ = c.st.CheckpointCrawl(ctx, crawlID, pagesDone, &store.Checkpoint{})
			case <-done:
				return
			case <-ctx.Done():
				return
			}
		}
	}()
	return func() { close(done) }
}

// fetchPage downloads, extracts, and stores one page, returning its links.
func (c *Crawler) fetchPage(ctx context.Context, site *store.Site, pageURL string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	if mt, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type")); mt != "" &&
		mt != "text/html" && mt != "application/xhtml+xml" {
		return nil, fmt.Errorf("skipping content-type %s", mt)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return nil, err
	}

	finalURL := resp.Request.URL
	if !c.sameSite(site, finalURL.Hostname()) {
		return nil, fmt.Errorf("redirected off-site to %s", finalURL)
	}
	ex, err := extract(string(body), finalURL)
	if err != nil {
		return nil, err
	}
	if ex.Markdown == "" {
		return ex.Links, fmt.Errorf("no content extracted")
	}
	path := finalURL.EscapedPath()
	if path == "" {
		path = "/"
	}
	page := &store.Page{
		SiteID:      site.ID,
		URL:         finalURL.String(),
		Path:        path,
		Title:       ex.Title,
		MetaDesc:    ex.MetaDesc,
		ContentHash: ex.Hash,
		Markdown:    ex.Markdown,
	}
	if err := c.st.UpsertPage(ctx, page); err != nil {
		return ex.Links, err
	}
	return ex.Links, nil
}

func (c *Crawler) fetchRobots(ctx context.Context, base string) *robotstxt.Group {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/robots.txt", nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	data, err := robotstxt.FromResponse(resp)
	if err != nil {
		return nil
	}
	return data.FindGroup("CloudAIrBot")
}

// normalize canonicalizes a URL and returns "" if it should not be crawled
// (off-site, non-http, binary-looking, tracking junk).
func (c *Crawler) normalize(site *store.Site, raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if !c.sameSite(site, host) {
		return ""
	}
	u.Fragment = ""
	u.User = nil
	u.Host = host
	// Strip tracking params.
	q := u.Query()
	for key := range q {
		if strings.HasPrefix(key, "utm_") || key == "ref" || key == "fbclid" || key == "gclid" {
			q.Del(key)
		}
	}
	u.RawQuery = q.Encode()
	if strings.HasSuffix(u.Path, "/") && u.Path != "/" {
		u.Path = strings.TrimSuffix(u.Path, "/")
	}
	if u.Path == "" {
		u.Path = "/"
	}
	lower := strings.ToLower(u.Path)
	for _, ext := range []string{".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".zip", ".gz", ".mp4", ".mp3", ".css", ".js", ".ico", ".xml", ".json", ".woff", ".woff2"} {
		if strings.HasSuffix(lower, ext) {
			return ""
		}
	}
	return u.String()
}

// sameSite allows the registered domain, its www variant, and subdomains.
func (c *Crawler) sameSite(site *store.Site, host string) bool {
	host = strings.ToLower(host)
	return host == site.Domain ||
		host == "www."+site.Domain ||
		strings.HasSuffix(host, "."+site.Domain)
}

func urlPath(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		if p := u.EscapedPath(); p != "" {
			return p
		}
	}
	return "/"
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
