package store

import (
	"context"
	"time"
)

type User struct {
	ID         string
	Provider   string
	ProviderID string
	Email      string
	Name       string
	CreatedAt  time.Time
}

// UpsertUser creates the user on first authenticated request (no Auth.js DB
// adapter — the dashboard proxy mints JWTs and we materialize users here).
func (s *Store) UpsertUser(ctx context.Context, provider, providerID, email, name string) (*User, error) {
	u := &User{Provider: provider, ProviderID: providerID}
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO users (provider, provider_id, email, name)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (provider, provider_id)
		DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
		RETURNING id, email, coalesce(name, ''), created_at`,
		provider, providerID, email, name,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}
