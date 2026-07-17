package crawler

import (
	"net/url"
	"testing"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

func TestNormalize(t *testing.T) {
	c := New(nil, nil)
	site := &store.Site{Domain: "example.com"}
	cases := map[string]string{
		"https://example.com/docs/":                        "https://example.com/docs",
		"https://EXAMPLE.com/a#frag":                       "https://example.com/a",
		"https://example.com/a?utm_source=x&q=1":           "https://example.com/a?q=1",
		"https://www.example.com/":                         "https://www.example.com/",
		"https://docs.example.com/guide":                   "https://docs.example.com/guide",
		"https://other.com/page":                           "",
		"mailto:hi@example.com":                            "",
		"https://example.com/logo.png":                     "",
		"https://example.com/style.css":                    "",
		"https://notexample.com/":                          "",
		"https://evil-example.com/":                        "",
	}
	for in, want := range cases {
		if got := c.normalize(site, in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtract(t *testing.T) {
	html := `<html><head><title>Test Page</title>
<meta name="description" content="A test page.">
</head><body><nav><a href="/nav">Nav</a></nav>
<article><h1>Heading</h1><p>This is the body text of the article, long enough for readability to keep it around hopefully.</p>
<a href="/docs/next">Next</a><a href="https://other.com/x">External</a></article></body></html>`
	u, _ := url.Parse("https://example.com/page")
	ex, err := extract(html, u)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if ex.Title != "Test Page" {
		t.Errorf("title = %q", ex.Title)
	}
	if ex.MetaDesc != "A test page." {
		t.Errorf("meta = %q", ex.MetaDesc)
	}
	if ex.Hash == "" || ex.Markdown == "" {
		t.Error("expected markdown and hash")
	}
	var sawRelative, sawExternal bool
	for _, l := range ex.Links {
		if l == "https://example.com/docs/next" {
			sawRelative = true
		}
		if l == "https://other.com/x" {
			sawExternal = true
		}
	}
	if !sawRelative {
		t.Errorf("relative link not resolved; links=%v", ex.Links)
	}
	if !sawExternal {
		t.Error("external links should be extracted (filtering happens in normalize)")
	}
}
