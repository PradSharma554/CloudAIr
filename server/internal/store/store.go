// Package store owns the Postgres connection pool, embedded migrations, and
// all SQL queries used by the CloudAIr server.
package store

import (
	"context"
	"embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

type Store struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	// Neon free tier suspends compute; keep idle connections short-lived so we
	// reconnect cleanly after a resume instead of erroring on a dead socket.
	cfg.MaxConns = 5
	cfg.MaxConnIdleTime = 2 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Migrate(ctx context.Context) error {
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return err
	}
	db := stdlib.OpenDBFromPool(s.Pool)
	defer db.Close()
	return goose.UpContext(ctx, db, "migrations")
}

func (s *Store) Health(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return s.Pool.Ping(ctx)
}

// DBSizeBytes reports current database size, surfaced on /healthz so Neon
// free-tier storage growth is visible before it bites.
func (s *Store) DBSizeBytes(ctx context.Context) (int64, error) {
	var size int64
	err := s.Pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&size)
	return size, err
}

func (s *Store) Close() {
	s.Pool.Close()
}
