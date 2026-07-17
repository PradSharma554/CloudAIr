// Package llm wraps the Gemini API with free-tier quota discipline: a hard
// requests-per-minute throttle, single retry on quota errors, and a disabled
// mode (no API key) that callers must treat as "use the fallback".
package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"
	"google.golang.org/genai"
)

type Client struct {
	client  *genai.Client
	model   string
	limiter *rate.Limiter
	calls   atomic.Int64
}

// New returns a disabled client (nil-safe) when apiKey is empty.
func New(ctx context.Context, apiKey, model string) (*Client, error) {
	if apiKey == "" {
		return nil, nil
	}
	gc, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return nil, err
	}
	return &Client{
		client: gc,
		model:  model,
		// 8 RPM stays under the free tier's ~10-15 RPM ceiling.
		limiter: rate.NewLimiter(rate.Limit(8.0/60.0), 1),
	}, nil
}

// Enabled reports whether LLM summarization is available.
func (c *Client) Enabled() bool { return c != nil }

// Calls returns the number of Gemini requests made since boot (logged so
// "recrawl of unchanged site costs 0 quota" is verifiable).
func (c *Client) Calls() int64 {
	if c == nil {
		return 0
	}
	return c.calls.Load()
}

func (c *Client) generate(ctx context.Context, prompt string, jsonOut bool) (string, error) {
	if c == nil {
		return "", fmt.Errorf("llm disabled")
	}
	if err := c.limiter.Wait(ctx); err != nil {
		return "", err
	}
	var cfg *genai.GenerateContentConfig
	if jsonOut {
		cfg = &genai.GenerateContentConfig{ResponseMIMEType: "application/json"}
	}
	c.calls.Add(1)
	resp, err := c.client.Models.GenerateContent(ctx, c.model, genai.Text(prompt), cfg)
	if err != nil && isQuotaErr(err) {
		slog.Warn("gemini quota hit, retrying once", "err", err)
		select {
		case <-time.After(30 * time.Second):
		case <-ctx.Done():
			return "", ctx.Err()
		}
		c.calls.Add(1)
		resp, err = c.client.Models.GenerateContent(ctx, c.model, genai.Text(prompt), cfg)
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(resp.Text()), nil
}

func isQuotaErr(err error) bool {
	s := err.Error()
	return strings.Contains(s, "429") || strings.Contains(s, "RESOURCE_EXHAUSTED")
}

// SummarizePage produces a one-sentence description for the llms.txt index.
func (c *Client) SummarizePage(ctx context.Context, title, markdown string) (string, error) {
	if len(markdown) > 4000 {
		markdown = markdown[:4000]
	}
	prompt := fmt.Sprintf(`You are writing an index of a website for AI agents (an llms.txt file).
Write a single-sentence description (25 words or fewer) of the following page.
Return ONLY the sentence — no quotes, no preamble.

Page title: %s

Page content (markdown, truncated):
%s`, title, markdown)
	out, err := c.generate(ctx, prompt, false)
	if err != nil {
		return "", err
	}
	// Keep it to one line regardless of what the model returns.
	if i := strings.IndexByte(out, '\n'); i >= 0 {
		out = out[:i]
	}
	return strings.TrimSpace(out), nil
}

type PageMeta struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
}

type Overview struct {
	SiteSummary string    `json:"site_summary"`
	Sections    []Section `json:"sections"`
}

type Section struct {
	Name  string   `json:"name"`
	Paths []string `json:"paths"`
}

// SiteOverview asks Gemini to summarize the site and group pages into
// llms.txt H2 sections.
func (c *Client) SiteOverview(ctx context.Context, domain string, pages []PageMeta) (*Overview, error) {
	list, err := json.Marshal(pages)
	if err != nil {
		return nil, err
	}
	prompt := fmt.Sprintf(`You are generating the structure of an llms.txt file for the website %s.
Given this JSON list of pages (path, title, summary), return JSON with:
- "site_summary": one paragraph (2-3 sentences) describing the site for AI agents
- "sections": 2-6 groups, each {"name": "Section Name", "paths": ["/path", ...]} covering the most important pages. Put low-value pages (legal, login, etc.) in a section named "Optional" or omit them.

Pages:
%s`, domain, list)
	out, err := c.generate(ctx, prompt, true)
	if err != nil {
		return nil, err
	}
	var ov Overview
	if err := json.Unmarshal([]byte(out), &ov); err != nil {
		return nil, fmt.Errorf("parse overview JSON: %w", err)
	}
	return &ov, nil
}
