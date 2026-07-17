package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

type AgentRequest struct {
	SiteID     string
	TS         time.Time
	AgentClass string
	AgentName  string
	Kind       string // 'llms_txt' | 'mcp_tool' | 'page'
	ToolName   string
	Path       string
	StatusCode int
	LatencyMS  int
	UserAgent  string
}

// InsertAgentRequests bulk-inserts buffered analytics events.
func (s *Store) InsertAgentRequests(ctx context.Context, events []AgentRequest) error {
	if len(events) == 0 {
		return nil
	}
	rows := make([][]any, len(events))
	for i, e := range events {
		rows[i] = []any{e.SiteID, e.TS, e.AgentClass, nullIfEmpty(e.AgentName), e.Kind,
			nullIfEmpty(e.ToolName), e.Path, e.StatusCode, e.LatencyMS, truncate(e.UserAgent, 256)}
	}
	_, err := s.Pool.CopyFrom(ctx,
		pgx.Identifier{"agent_requests"},
		[]string{"site_id", "ts", "agent_class", "agent_name", "kind", "tool_name", "path", "status_code", "latency_ms", "user_agent"},
		pgx.CopyFromRows(rows))
	return err
}

type TimeseriesPoint struct {
	Bucket time.Time `json:"bucket"`
	Count  int       `json:"count"`
}

func (s *Store) AnalyticsTimeseries(ctx context.Context, siteID string, since time.Time, bucket string) ([]TimeseriesPoint, error) {
	if bucket != "hour" {
		bucket = "day"
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT date_trunc($3, ts) AS bucket, count(*)::int
		FROM agent_requests
		WHERE site_id = $1 AND ts >= $2
		GROUP BY 1 ORDER BY 1`, siteID, since, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	points := []TimeseriesPoint{}
	for rows.Next() {
		var p TimeseriesPoint
		if err := rows.Scan(&p.Bucket, &p.Count); err != nil {
			return nil, err
		}
		points = append(points, p)
	}
	return points, rows.Err()
}

type TopEntry struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// AnalyticsTop aggregates the busiest agents or paths over a window.
// by must be one of: agent, path, tool, class.
func (s *Store) AnalyticsTop(ctx context.Context, siteID, by string, since time.Time, limit int) ([]TopEntry, error) {
	col := map[string]string{
		"agent": `coalesce(agent_name, 'unidentified')`,
		"path":  `coalesce(path, '')`,
		"tool":  `coalesce(tool_name, '')`,
		"class": `agent_class`,
	}[by]
	if col == "" {
		col = `coalesce(agent_name, 'unidentified')`
	}
	if limit <= 0 || limit > 50 {
		limit = 10
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT `+col+` AS key, count(*)::int
		FROM agent_requests
		WHERE site_id = $1 AND ts >= $2
		GROUP BY 1 ORDER BY 2 DESC LIMIT $3`, siteID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []TopEntry{}
	for rows.Next() {
		var e TopEntry
		if err := rows.Scan(&e.Key, &e.Count); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// RollupAndPrune folds raw events older than a day into permanent daily
// rollups, then deletes raw events past the 30-day retention window. Runs on
// the daily GitHub Actions cron hit; keeps Neon's 0.5GB budget honest.
func (s *Store) RollupAndPrune(ctx context.Context) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_requests_daily (site_id, day, agent_class, agent_name, kind, request_count)
		SELECT site_id, ts::date, agent_class, coalesce(agent_name, ''), kind, count(*)::int
		FROM agent_requests
		WHERE ts < date_trunc('day', now())
		GROUP BY 1, 2, 3, 4, 5
		ON CONFLICT (site_id, day, agent_class, agent_name, kind)
		DO UPDATE SET request_count = EXCLUDED.request_count`); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM agent_requests WHERE ts < now() - interval '30 days'`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
