package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type Page struct {
	ID          string     `json:"id"`
	SiteID      string     `json:"-"`
	URL         string     `json:"url"`
	Path        string     `json:"path"`
	Title       string     `json:"title"`
	MetaDesc    string     `json:"-"`
	ContentHash string     `json:"-"`
	Markdown    string     `json:"-"`
	Summary     string     `json:"summary"`
	SummaryHash string     `json:"-"`
	FetchedAt   *time.Time `json:"fetched_at,omitempty"`
}

type SearchResult struct {
	Path    string  `json:"path"`
	URL     string  `json:"url"`
	Title   string  `json:"title"`
	Summary string  `json:"summary"`
	Snippet string  `json:"snippet"`
	Rank    float32 `json:"-"`
}

// UpsertPage stores a crawled page, preserving an existing summary when the
// content hash is unchanged so recrawls cost zero Gemini quota.
func (s *Store) UpsertPage(ctx context.Context, p *Page) error {
	_, err := s.Pool.Exec(ctx, `
		INSERT INTO pages (site_id, url, path, title, meta_desc, content_hash, markdown, http_status, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 200, now())
		ON CONFLICT (site_id, url) DO UPDATE SET
			path = EXCLUDED.path,
			title = EXCLUDED.title,
			meta_desc = EXCLUDED.meta_desc,
			content_hash = EXCLUDED.content_hash,
			markdown = EXCLUDED.markdown,
			fetched_at = now()`,
		p.SiteID, p.URL, p.Path, p.Title, p.MetaDesc, p.ContentHash, p.Markdown)
	return err
}

func (s *Store) SetPageSummary(ctx context.Context, siteID, url, summary, summaryHash string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE pages SET summary = $3, summary_hash = $4 WHERE site_id = $1 AND url = $2`,
		siteID, url, summary, summaryHash)
	return err
}

const pageCols = `id, site_id, url, path, coalesce(title, ''), coalesce(meta_desc, ''),
	content_hash, markdown, coalesce(summary, ''), coalesce(summary_hash, ''), fetched_at`

func scanPage(row pgx.Row) (*Page, error) {
	var p Page
	err := row.Scan(&p.ID, &p.SiteID, &p.URL, &p.Path, &p.Title, &p.MetaDesc,
		&p.ContentHash, &p.Markdown, &p.Summary, &p.SummaryHash, &p.FetchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) GetPageByPath(ctx context.Context, siteID, path string) (*Page, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+pageCols+` FROM pages WHERE site_id = $1 AND path = $2 ORDER BY fetched_at DESC LIMIT 1`,
		siteID, path)
	return scanPage(row)
}

// ListPages returns pages without their markdown bodies (metadata only).
func (s *Store) ListPages(ctx context.Context, siteID string) ([]*Page, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id, url, path, coalesce(title, ''), coalesce(meta_desc, ''),
		       content_hash, coalesce(summary, ''), coalesce(summary_hash, ''), fetched_at
		FROM pages WHERE site_id = $1 ORDER BY path`, siteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pages := []*Page{}
	for rows.Next() {
		p := Page{SiteID: siteID}
		if err := rows.Scan(&p.ID, &p.URL, &p.Path, &p.Title, &p.MetaDesc,
			&p.ContentHash, &p.Summary, &p.SummaryHash, &p.FetchedAt); err != nil {
			return nil, err
		}
		pages = append(pages, &p)
	}
	return pages, rows.Err()
}

// IteratePagesFull streams full page bodies one at a time (for llms-full.txt)
// so a 50-page site never sits in memory at once.
func (s *Store) IteratePagesFull(ctx context.Context, siteID string, fn func(*Page) error) error {
	rows, err := s.Pool.Query(ctx,
		`SELECT `+pageCols+` FROM pages WHERE site_id = $1 ORDER BY path`, siteID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		p, err := scanPage(rows)
		if err != nil {
			return err
		}
		if err := fn(p); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Store) SearchPages(ctx context.Context, siteID, query string, limit int) ([]SearchResult, error) {
	if limit <= 0 || limit > 20 {
		limit = 5
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT path, url, coalesce(title, ''), coalesce(summary, ''),
		       ts_headline('english', left(markdown, 20000), websearch_to_tsquery('english', $2),
		                   'MaxFragments=2, MaxWords=30, MinWords=10'),
		       ts_rank(tsv, websearch_to_tsquery('english', $2))
		FROM pages
		WHERE site_id = $1 AND tsv @@ websearch_to_tsquery('english', $2)
		ORDER BY ts_rank(tsv, websearch_to_tsquery('english', $2)) DESC
		LIMIT $3`, siteID, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []SearchResult{}
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.Path, &r.URL, &r.Title, &r.Summary, &r.Snippet, &r.Rank); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	return results, rows.Err()
}

// DeleteStalePages removes pages that were not seen in the latest crawl.
func (s *Store) DeleteStalePages(ctx context.Context, siteID string, before time.Time) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM pages WHERE site_id = $1 AND fetched_at < $2`, siteID, before)
	return err
}
