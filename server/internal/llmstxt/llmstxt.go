// Package llmstxt generates spec-compliant llms.txt files from crawled pages,
// using Gemini when available and a deterministic fallback (meta descriptions
// + path-based sections) otherwise — generation never fails because the LLM
// is down or out of quota.
package llmstxt

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"

	"github.com/PradSharma554/CloudAIr/server/internal/llm"
	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

type Generator struct {
	st            *store.Store
	llm           *llm.Client
	publicBaseURL string
}

func NewGenerator(st *store.Store, llmClient *llm.Client, publicBaseURL string) *Generator {
	return &Generator{st: st, llm: llmClient, publicBaseURL: strings.TrimSuffix(publicBaseURL, "/")}
}

// Generate summarizes pages (cached by content hash), builds the section
// structure, renders llms.txt, and stores it on the site.
func (g *Generator) Generate(ctx context.Context, site *store.Site) error {
	if unchanged, err := g.nothingChanged(ctx, site); err == nil && unchanged {
		slog.Info("llms.txt up to date, skipping generation (0 LLM calls)", "site", site.Domain)
		return nil
	}
	if err := g.summarizePages(ctx, site); err != nil {
		slog.Warn("page summarization incomplete, continuing with fallbacks", "site", site.Domain, "err", err)
	}
	pages, err := g.st.ListPages(ctx, site.ID)
	if err != nil {
		return err
	}
	if len(pages) == 0 {
		return fmt.Errorf("no pages crawled for %s", site.Domain)
	}
	overview := g.overview(ctx, site, pages)
	txt := g.Render(site, overview, pages)
	return g.st.UpdateSiteLLMSTxt(ctx, site.ID, txt)
}

// nothingChanged reports whether a recrawl produced identical content: an
// llms.txt exists and every page summary matches its content hash. Only
// meaningful with the LLM enabled — fallback summaries carry no summary_hash
// so they are retried (and upgraded) once a key is configured.
func (g *Generator) nothingChanged(ctx context.Context, site *store.Site) (bool, error) {
	if !g.llm.Enabled() || site.LLMSTxt == "" {
		return false, nil
	}
	pages, err := g.st.ListPages(ctx, site.ID)
	if err != nil || len(pages) == 0 {
		return false, err
	}
	for _, p := range pages {
		if p.SummaryHash != p.ContentHash || p.Summary == "" {
			return false, nil
		}
	}
	return true, nil
}

// summarizePages fills in Gemini summaries for pages whose content changed
// since the last summary. Unchanged pages cost zero quota.
func (g *Generator) summarizePages(ctx context.Context, site *store.Site) error {
	if !g.llm.Enabled() {
		return nil
	}
	var firstErr error
	err := g.st.IteratePagesFull(ctx, site.ID, func(p *store.Page) error {
		if p.SummaryHash == p.ContentHash && p.Summary != "" {
			return nil
		}
		summary, err := g.llm.SummarizePage(ctx, p.Title, p.Markdown)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			return nil // keep going; fallback covers this page
		}
		if err := g.st.SetPageSummary(ctx, site.ID, p.URL, summary, p.ContentHash); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	return firstErr
}

func (g *Generator) overview(ctx context.Context, site *store.Site, pages []*store.Page) *llm.Overview {
	if g.llm.Enabled() {
		metas := make([]llm.PageMeta, 0, len(pages))
		for _, p := range pages {
			metas = append(metas, llm.PageMeta{Path: p.Path, Title: p.Title, Summary: displaySummary(p)})
		}
		ov, err := g.llm.SiteOverview(ctx, site.Domain, metas)
		if err == nil && ov.SiteSummary != "" {
			return ov
		}
		slog.Warn("site overview LLM call failed, using fallback sections", "site", site.Domain, "err", err)
	}
	return fallbackOverview(pages)
}

// fallbackOverview groups pages by first path segment and takes the site
// summary from the homepage.
func fallbackOverview(pages []*store.Page) *llm.Overview {
	ov := &llm.Overview{}
	groups := map[string][]string{}
	for _, p := range pages {
		if p.Path == "/" || p.Path == "" {
			if ov.SiteSummary == "" {
				ov.SiteSummary = displaySummary(p)
			}
			groups["Overview"] = append(groups["Overview"], p.Path)
			continue
		}
		seg := strings.SplitN(strings.TrimPrefix(p.Path, "/"), "/", 2)[0]
		name := titleCase(strings.ReplaceAll(strings.ReplaceAll(seg, "-", " "), "_", " "))
		groups[name] = append(groups[name], p.Path)
	}
	names := make([]string, 0, len(groups))
	for name := range groups {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i] == "Overview" {
			return true
		}
		if names[j] == "Overview" {
			return false
		}
		return names[i] < names[j]
	})
	for _, name := range names {
		ov.Sections = append(ov.Sections, llm.Section{Name: name, Paths: groups[name]})
	}
	return ov
}

// Render produces the llms.txt document: H1 title, blockquote summary, H2
// sections with "- [title](url): description" link lists. Links point at the
// CloudAIr markdown mirror so agent traffic flows through the access layer.
func (g *Generator) Render(site *store.Site, ov *llm.Overview, pages []*store.Page) string {
	byPath := map[string]*store.Page{}
	for _, p := range pages {
		byPath[p.Path] = p
	}
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", site.Domain)
	if s := strings.TrimSpace(ov.SiteSummary); s != "" {
		fmt.Fprintf(&b, "> %s\n\n", strings.ReplaceAll(s, "\n", " "))
	}
	fmt.Fprintf(&b, "This site is served to AI agents by CloudAIr. Machine-readable page mirrors and an MCP endpoint are available.\n")
	fmt.Fprintf(&b, "MCP endpoint (Streamable HTTP): %s/sites/%s/mcp\n\n", g.publicBaseURL, site.Slug)

	used := map[string]bool{}
	writeSection := func(name string, paths []string) {
		var lines []string
		for _, path := range paths {
			p, ok := byPath[path]
			if !ok || used[path] {
				continue
			}
			used[path] = true
			lines = append(lines, g.linkLine(site, p))
		}
		if len(lines) == 0 {
			return
		}
		fmt.Fprintf(&b, "## %s\n\n", name)
		for _, l := range lines {
			b.WriteString(l)
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	for _, sec := range ov.Sections {
		writeSection(sec.Name, sec.Paths)
	}
	var rest []string
	for _, p := range pages {
		if !used[p.Path] {
			rest = append(rest, p.Path)
		}
	}
	writeSection("Other", rest)
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func (g *Generator) linkLine(site *store.Site, p *store.Page) string {
	title := p.Title
	if title == "" {
		title = p.Path
	}
	mirror := fmt.Sprintf("%s/sites/%s/pages%s", g.publicBaseURL, site.Slug, p.Path)
	if desc := displaySummary(p); desc != "" {
		return fmt.Sprintf("- [%s](%s): %s", title, mirror, desc)
	}
	return fmt.Sprintf("- [%s](%s)", title, mirror)
}

// displaySummary prefers the LLM summary, then the meta description, then the
// first sentence-ish slice of content.
func displaySummary(p *store.Page) string {
	if p.Summary != "" {
		return p.Summary
	}
	if p.MetaDesc != "" {
		return oneLine(p.MetaDesc, 200)
	}
	return firstProse(p.Markdown)
}

// firstProse pulls the first plain-text paragraph out of markdown.
func firstProse(md string) string {
	for _, para := range strings.Split(md, "\n\n") {
		para = strings.TrimSpace(para)
		if para == "" || strings.HasPrefix(para, "#") || strings.HasPrefix(para, "!") ||
			strings.HasPrefix(para, "|") || strings.HasPrefix(para, "```") ||
			strings.HasPrefix(para, "-") || strings.HasPrefix(para, "*") {
			continue
		}
		return oneLine(para, 200)
	}
	return ""
}

func oneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > max {
		cut := s[:max]
		if i := strings.LastIndexByte(cut, ' '); i > 0 {
			cut = cut[:i]
		}
		s = cut + "…"
	}
	return s
}

func titleCase(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	if len(words) == 0 {
		return "Pages"
	}
	return strings.Join(words, " ")
}
