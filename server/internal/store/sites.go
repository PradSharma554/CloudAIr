package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrNotFound = errors.New("not found")

type SiteSettings struct {
	Monetization Monetization  `json:"monetization"`
	Crawl        CrawlSettings `json:"crawl"`
}

type Monetization struct {
	Enabled  bool    `json:"enabled"`
	PriceUSD float64 `json:"price_usd,omitempty"`
	Network  string  `json:"network,omitempty"`
	PayTo    string  `json:"pay_to,omitempty"`
}

type CrawlSettings struct {
	MaxPages int `json:"max_pages,omitempty"`
}

type Site struct {
	ID                 string       `json:"id"`
	UserID             string       `json:"-"`
	Domain             string       `json:"domain"`
	Slug               string       `json:"slug"`
	VerificationToken  string       `json:"verification_token"`
	VerificationMethod string       `json:"verification_method,omitempty"`
	VerifiedAt         *time.Time   `json:"verified_at,omitempty"`
	LLMSTxt            string       `json:"-"`
	LLMSTxtGeneratedAt *time.Time   `json:"llms_txt_generated_at,omitempty"`
	Settings           SiteSettings `json:"settings"`
	CreatedAt          time.Time    `json:"created_at"`
}

func (site *Site) MaxPages() int {
	if site.Settings.Crawl.MaxPages > 0 && site.Settings.Crawl.MaxPages <= 50 {
		return site.Settings.Crawl.MaxPages
	}
	return 50
}

const siteCols = `id, user_id, domain, slug, verification_token,
	coalesce(verification_method, ''), verified_at,
	coalesce(llms_txt, ''), llms_txt_generated_at, settings, created_at`

func scanSite(row pgx.Row) (*Site, error) {
	var site Site
	var settings []byte
	err := row.Scan(&site.ID, &site.UserID, &site.Domain, &site.Slug,
		&site.VerificationToken, &site.VerificationMethod, &site.VerifiedAt,
		&site.LLMSTxt, &site.LLMSTxtGeneratedAt, &settings, &site.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(settings, &site.Settings)
	return &site, nil
}

func (s *Store) CreateSite(ctx context.Context, userID, domain, slug, token string) (*Site, error) {
	row := s.Pool.QueryRow(ctx, `
		INSERT INTO sites (user_id, domain, slug, verification_token)
		VALUES ($1, $2, $3, $4)
		RETURNING `+siteCols, userID, domain, slug, token)
	return scanSite(row)
}

func (s *Store) GetSiteByID(ctx context.Context, id string) (*Site, error) {
	row := s.Pool.QueryRow(ctx, `SELECT `+siteCols+` FROM sites WHERE id = $1`, id)
	return scanSite(row)
}

func (s *Store) GetSiteBySlug(ctx context.Context, slug string) (*Site, error) {
	row := s.Pool.QueryRow(ctx, `SELECT `+siteCols+` FROM sites WHERE slug = $1`, slug)
	return scanSite(row)
}

func (s *Store) GetSiteByDomain(ctx context.Context, domain string) (*Site, error) {
	row := s.Pool.QueryRow(ctx, `SELECT `+siteCols+` FROM sites WHERE domain = $1`, domain)
	return scanSite(row)
}

func (s *Store) ListSitesByUser(ctx context.Context, userID string) ([]*Site, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+siteCols+` FROM sites WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sites := []*Site{}
	for rows.Next() {
		site, err := scanSite(rows)
		if err != nil {
			return nil, err
		}
		sites = append(sites, site)
	}
	return sites, rows.Err()
}

func (s *Store) ListVerifiedSites(ctx context.Context) ([]*Site, error) {
	rows, err := s.Pool.Query(ctx, `SELECT `+siteCols+` FROM sites WHERE verified_at IS NOT NULL ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sites := []*Site{}
	for rows.Next() {
		site, err := scanSite(rows)
		if err != nil {
			return nil, err
		}
		sites = append(sites, site)
	}
	return sites, rows.Err()
}

func (s *Store) DeleteSite(ctx context.Context, id string) error {
	_, err := s.Pool.Exec(ctx, `DELETE FROM sites WHERE id = $1`, id)
	return err
}

func (s *Store) MarkSiteVerified(ctx context.Context, id, method string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE sites SET verification_method = $2, verified_at = now() WHERE id = $1`, id, method)
	return err
}

func (s *Store) UpdateSiteLLMSTxt(ctx context.Context, id, llmsTxt string) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE sites SET llms_txt = $2, llms_txt_generated_at = now() WHERE id = $1`, id, llmsTxt)
	return err
}

func (s *Store) UpdateSiteSettings(ctx context.Context, id string, settings SiteSettings) error {
	b, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `UPDATE sites SET settings = $2 WHERE id = $1`, id, b)
	return err
}
