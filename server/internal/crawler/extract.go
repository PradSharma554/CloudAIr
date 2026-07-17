package crawler

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"

	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
	"github.com/PuerkitoBio/goquery"
	readability "github.com/go-shiori/go-readability"
)

const maxMarkdownBytes = 200 * 1024 // Neon storage budget: ≤200KB per page

type extracted struct {
	Title    string
	MetaDesc string
	Markdown string
	Hash     string
	Links    []string
}

// extract turns raw HTML into clean markdown plus outbound links.
func extract(rawHTML string, pageURL *url.URL) (*extracted, error) {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(rawHTML))
	if err != nil {
		return nil, err
	}
	e := &extracted{}
	e.Title = strings.TrimSpace(doc.Find("title").First().Text())
	e.MetaDesc, _ = doc.Find(`meta[name="description"]`).First().Attr("content")
	e.MetaDesc = strings.TrimSpace(e.MetaDesc)

	doc.Find("a[href]").Each(func(_ int, sel *goquery.Selection) {
		href, _ := sel.Attr("href")
		if href == "" {
			return
		}
		ref, err := url.Parse(strings.TrimSpace(href))
		if err != nil {
			return
		}
		e.Links = append(e.Links, pageURL.ResolveReference(ref).String())
	})

	// Readability strips nav/chrome; fall back to the whole body when it
	// can't find an article (e.g. link-heavy index pages).
	content := rawHTML
	if article, err := readability.FromReader(strings.NewReader(rawHTML), pageURL); err == nil && article.Content != "" {
		content = article.Content
		if e.Title == "" {
			e.Title = article.Title
		}
	}
	md, err := htmltomarkdown.ConvertString(content)
	if err != nil {
		return nil, err
	}
	md = strings.TrimSpace(md)
	if len(md) > maxMarkdownBytes {
		md = md[:maxMarkdownBytes]
	}
	sum := sha256.Sum256([]byte(md))
	e.Markdown = md
	e.Hash = hex.EncodeToString(sum[:])
	return e, nil
}
