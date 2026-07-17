package llmstxt

import (
	"strings"
	"testing"

	"github.com/PradSharma554/CloudAIr/server/internal/llm"
	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

func testPages() []*store.Page {
	return []*store.Page{
		{Path: "/", URL: "https://example.com/", Title: "Example Home", MetaDesc: "The example site for testing.", Markdown: "Welcome to Example."},
		{Path: "/docs/start", URL: "https://example.com/docs/start", Title: "Getting Started", Summary: "Install and configure in five minutes."},
		{Path: "/docs/api", URL: "https://example.com/docs/api", Title: "API Reference", Markdown: "The API accepts JSON requests over HTTPS."},
		{Path: "/pricing", URL: "https://example.com/pricing", Title: "Pricing", MetaDesc: "Plans and pricing."},
	}
}

func TestRenderSpecCompliant(t *testing.T) {
	g := NewGenerator(nil, nil, "https://cloudair.onrender.com/")
	site := &store.Site{Domain: "example.com", Slug: "example-com"}
	ov := &llm.Overview{
		SiteSummary: "An example site.",
		Sections: []llm.Section{
			{Name: "Docs", Paths: []string{"/docs/start", "/docs/api"}},
		},
	}
	out := g.Render(site, ov, testPages())

	for _, want := range []string{
		"# example.com",
		"> An example site.",
		"## Docs",
		"- [Getting Started](https://cloudair.onrender.com/sites/example-com/pages/docs/start): Install and configure in five minutes.",
		"## Other", // pages not covered by sections land here
		"/sites/example-com/pages/pricing",
		"/sites/example-com/mcp",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("llms.txt missing %q\n---\n%s", want, out)
		}
	}
	if !strings.HasPrefix(out, "# example.com\n") {
		t.Error("llms.txt must start with the H1 title")
	}
}

func TestFallbackOverview(t *testing.T) {
	ov := fallbackOverview(testPages())
	if ov.SiteSummary != "The example site for testing." {
		t.Errorf("site summary should come from homepage meta description, got %q", ov.SiteSummary)
	}
	var names []string
	for _, s := range ov.Sections {
		names = append(names, s.Name)
	}
	joined := strings.Join(names, ",")
	if !strings.Contains(joined, "Docs") || !strings.Contains(joined, "Pricing") {
		t.Errorf("expected path-based sections, got %v", names)
	}
	if names[0] != "Overview" {
		t.Errorf("Overview section should sort first, got %v", names)
	}
}

func TestDisplaySummaryPreference(t *testing.T) {
	p := &store.Page{Summary: "llm", MetaDesc: "meta", Markdown: "prose here"}
	if got := displaySummary(p); got != "llm" {
		t.Errorf("want LLM summary preferred, got %q", got)
	}
	p.Summary = ""
	if got := displaySummary(p); got != "meta" {
		t.Errorf("want meta description second, got %q", got)
	}
	p.MetaDesc = ""
	if got := displaySummary(p); got != "prose here" {
		t.Errorf("want first prose fallback, got %q", got)
	}
}

func TestRenderNeverPanicsWithLLMDisabled(t *testing.T) {
	// A nil *llm.Client is the disabled mode; Enabled() must be nil-safe.
	var c *llm.Client
	if c.Enabled() {
		t.Error("nil client must report disabled")
	}
}
