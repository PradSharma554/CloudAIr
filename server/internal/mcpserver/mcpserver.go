// Package mcpserver exposes each registered site as a stateless Streamable
// HTTP MCP server with search_site / get_page / list_pages tools. All SDK
// types are confined to this package.
package mcpserver

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

type Manager struct {
	st            *store.Store
	publicBaseURL string
	servers       *lru.Cache[string, *mcp.Server] // site ID → server
}

func NewManager(st *store.Store, publicBaseURL string) *Manager {
	cache, _ := lru.New[string, *mcp.Server](256)
	return &Manager{st: st, publicBaseURL: strings.TrimSuffix(publicBaseURL, "/"), servers: cache}
}

// Handler returns the Streamable HTTP handler for a resolved site. Stateless
// mode: each POST is self-contained, so Render spin-downs are invisible to
// clients beyond cold-start latency.
func (m *Manager) Handler(site *store.Site) http.Handler {
	return mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return m.serverFor(site) },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true},
	)
}

func (m *Manager) serverFor(site *store.Site) *mcp.Server {
	if srv, ok := m.servers.Get(site.ID); ok {
		return srv
	}
	srv := mcp.NewServer(
		&mcp.Implementation{Name: "cloudair-" + site.Slug, Title: site.Domain + " (via CloudAIr)", Version: "1.0.0"},
		&mcp.ServerOptions{
			Instructions: fmt.Sprintf(
				"This server exposes the content of %s. Use search_site to find relevant pages, "+
					"then get_page to read one. list_pages returns the full index. "+
					"An llms.txt overview is available at %s/sites/%s/llms.txt.",
				site.Domain, m.publicBaseURL, site.Slug),
		},
	)

	type searchIn struct {
		Query string `json:"query" jsonschema:"the search query"`
		Limit int    `json:"limit,omitempty" jsonschema:"max results to return (default 5, max 20)"`
	}
	type searchOut struct {
		Results []store.SearchResult `json:"results"`
	}
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "search_site",
		Description: fmt.Sprintf("Full-text search over the pages of %s. Returns matching pages with snippets.", site.Domain),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, searchOut, error) {
		if strings.TrimSpace(in.Query) == "" {
			return nil, searchOut{}, fmt.Errorf("query is required")
		}
		results, err := m.st.SearchPages(ctx, site.ID, in.Query, in.Limit)
		if err != nil {
			return nil, searchOut{}, fmt.Errorf("search failed: %w", err)
		}
		return nil, searchOut{Results: results}, nil
	})

	type getPageIn struct {
		Path string `json:"path" jsonschema:"page path starting with /, e.g. /docs/start"`
	}
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "get_page",
		Description: fmt.Sprintf("Fetch one page of %s as clean markdown by its path.", site.Domain),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getPageIn) (*mcp.CallToolResult, any, error) {
		path := in.Path
		if path == "" {
			path = "/"
		}
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		page, err := m.st.GetPageByPath(ctx, site.ID, path)
		if err == store.ErrNotFound {
			return nil, nil, fmt.Errorf("no page at %s — use list_pages or search_site to find valid paths", path)
		}
		if err != nil {
			return nil, nil, fmt.Errorf("lookup failed: %w", err)
		}
		text := fmt.Sprintf("# %s\n\nSource: %s\n\n%s", page.Title, page.URL, page.Markdown)
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: text}},
		}, nil, nil
	})

	type pageEntry struct {
		Path    string `json:"path"`
		Title   string `json:"title"`
		Summary string `json:"summary,omitempty"`
	}
	type listOut struct {
		Pages []pageEntry `json:"pages"`
	}
	mcp.AddTool(srv, &mcp.Tool{
		Name:        "list_pages",
		Description: fmt.Sprintf("List all indexed pages of %s with titles and summaries.", site.Domain),
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ any) (*mcp.CallToolResult, listOut, error) {
		pages, err := m.st.ListPages(ctx, site.ID)
		if err != nil {
			return nil, listOut{}, fmt.Errorf("list failed: %w", err)
		}
		out := listOut{Pages: make([]pageEntry, 0, len(pages))}
		for _, p := range pages {
			out.Pages = append(out.Pages, pageEntry{Path: p.Path, Title: p.Title, Summary: p.Summary})
		}
		return nil, out, nil
	})

	m.servers.Add(site.ID, srv)
	return srv
}

// Invalidate drops the cached server for a site (e.g. after deletion).
func (m *Manager) Invalidate(siteID string) {
	m.servers.Remove(siteID)
}
