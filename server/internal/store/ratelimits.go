package store

import (
	"context"
)

type RateLimitRule struct {
	ID          string `json:"id,omitempty"`
	SiteID      string `json:"-"`
	SubjectType string `json:"subject_type"` // 'class' | 'agent'
	Subject     string `json:"subject"`      // 'declared-agent' | 'GPTBot' | '*'
	RPM         int    `json:"rpm"`
	Burst       int    `json:"burst"`
}

func (s *Store) ListRateLimitRules(ctx context.Context, siteID string) ([]RateLimitRule, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id, subject_type, subject, rpm, burst
		FROM rate_limit_rules WHERE site_id = $1 ORDER BY subject_type, subject`, siteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []RateLimitRule{}
	for rows.Next() {
		r := RateLimitRule{SiteID: siteID}
		if err := rows.Scan(&r.ID, &r.SubjectType, &r.Subject, &r.RPM, &r.Burst); err != nil {
			return nil, err
		}
		rules = append(rules, r)
	}
	return rules, rows.Err()
}

// RateLimitRuleMap returns a site's rules keyed for the limiter's precedence
// lookup: "agent:<name>", "class:<class>", and "site:*" for the wildcard.
func (s *Store) RateLimitRuleMap(ctx context.Context, siteID string) (map[string][2]int, error) {
	rules, err := s.ListRateLimitRules(ctx, siteID)
	if err != nil {
		return nil, err
	}
	m := make(map[string][2]int, len(rules))
	for _, r := range rules {
		key := r.SubjectType + ":" + r.Subject
		if r.Subject == "*" {
			key = "site:*"
		}
		m[key] = [2]int{r.RPM, r.Burst}
	}
	return m, nil
}

// ReplaceRateLimitRules swaps a site's full rule set atomically (the settings
// UI submits the whole list).
func (s *Store) ReplaceRateLimitRules(ctx context.Context, siteID string, rules []RateLimitRule) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM rate_limit_rules WHERE site_id = $1`, siteID); err != nil {
		return err
	}
	for _, r := range rules {
		if _, err := tx.Exec(ctx, `
			INSERT INTO rate_limit_rules (site_id, subject_type, subject, rpm, burst)
			VALUES ($1, $2, $3, $4, $5)`,
			siteID, r.SubjectType, r.Subject, r.RPM, r.Burst); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
