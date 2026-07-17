package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	CrawlQueued    = "queued"
	CrawlRunning   = "running"
	CrawlCompleted = "completed"
	CrawlFailed    = "failed"
	CrawlStalled   = "stalled"
)

// Checkpoint persists crawl progress after every page so a Render free-tier
// spin-down mid-crawl loses at most one page of work.
type Checkpoint struct {
	Frontier []string `json:"frontier"`
	Visited  []string `json:"visited"`
}

type Crawl struct {
	ID           string      `json:"id"`
	SiteID       string      `json:"-"`
	Status       string      `json:"status"`
	PagesCrawled int         `json:"pages_crawled"`
	MaxPages     int         `json:"max_pages"`
	Checkpoint   *Checkpoint `json:"-"`
	Error        string      `json:"error,omitempty"`
	HeartbeatAt  *time.Time  `json:"-"`
	StartedAt    *time.Time  `json:"started_at,omitempty"`
	FinishedAt   *time.Time  `json:"finished_at,omitempty"`
	CreatedAt    time.Time   `json:"created_at"`
}

const crawlCols = `id, site_id, status, pages_crawled, max_pages, checkpoint,
	coalesce(error, ''), heartbeat_at, started_at, finished_at, created_at`

func scanCrawl(row pgx.Row) (*Crawl, error) {
	var c Crawl
	var checkpoint []byte
	err := row.Scan(&c.ID, &c.SiteID, &c.Status, &c.PagesCrawled, &c.MaxPages,
		&checkpoint, &c.Error, &c.HeartbeatAt, &c.StartedAt, &c.FinishedAt, &c.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(checkpoint) > 0 {
		c.Checkpoint = &Checkpoint{}
		_ = json.Unmarshal(checkpoint, c.Checkpoint)
	}
	return &c, nil
}

func (s *Store) CreateCrawl(ctx context.Context, siteID string, maxPages int) (*Crawl, error) {
	row := s.Pool.QueryRow(ctx, `
		INSERT INTO crawls (site_id, max_pages, status, started_at, heartbeat_at)
		VALUES ($1, $2, 'running', now(), now())
		RETURNING `+crawlCols, siteID, maxPages)
	return scanCrawl(row)
}

func (s *Store) LatestCrawl(ctx context.Context, siteID string) (*Crawl, error) {
	row := s.Pool.QueryRow(ctx,
		`SELECT `+crawlCols+` FROM crawls WHERE site_id = $1 ORDER BY created_at DESC LIMIT 1`, siteID)
	return scanCrawl(row)
}

// RunningCrawl returns the active crawl for a site, if any (running with a
// fresh heartbeat).
func (s *Store) RunningCrawl(ctx context.Context, siteID string) (*Crawl, error) {
	row := s.Pool.QueryRow(ctx, `
		SELECT `+crawlCols+` FROM crawls
		WHERE site_id = $1 AND status = 'running' AND heartbeat_at > now() - interval '2 minutes'
		ORDER BY created_at DESC LIMIT 1`, siteID)
	return scanCrawl(row)
}

// CheckpointCrawl records progress and touches the heartbeat in one statement.
func (s *Store) CheckpointCrawl(ctx context.Context, crawlID string, pagesCrawled int, cp *Checkpoint) error {
	b, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `
		UPDATE crawls SET pages_crawled = $2, checkpoint = $3, heartbeat_at = now()
		WHERE id = $1`, crawlID, pagesCrawled, b)
	return err
}

func (s *Store) FinishCrawl(ctx context.Context, crawlID, status, errMsg string) error {
	_, err := s.Pool.Exec(ctx, `
		UPDATE crawls SET status = $2, error = nullif($3, ''), finished_at = now(), checkpoint = NULL
		WHERE id = $1`, crawlID, status, errMsg)
	return err
}

// ReapStalledCrawls marks running crawls whose goroutine died (stale
// heartbeat) as stalled, and returns them so the caller can resume from
// their checkpoints.
func (s *Store) ReapStalledCrawls(ctx context.Context) ([]*Crawl, error) {
	rows, err := s.Pool.Query(ctx, `
		UPDATE crawls SET status = 'stalled'
		WHERE status = 'running' AND heartbeat_at < now() - interval '2 minutes'
		RETURNING `+crawlCols)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	crawls := []*Crawl{}
	for rows.Next() {
		c, err := scanCrawl(rows)
		if err != nil {
			return nil, err
		}
		crawls = append(crawls, c)
	}
	return crawls, rows.Err()
}

// ResumeCrawl flips a stalled crawl back to running for a resume attempt.
func (s *Store) ResumeCrawl(ctx context.Context, crawlID string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE crawls SET status = 'running', heartbeat_at = now() WHERE id = $1`, crawlID)
	return err
}
