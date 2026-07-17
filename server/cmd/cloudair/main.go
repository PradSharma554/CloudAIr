// Command cloudair runs the CloudAIr server: agent-facing site endpoints
// (llms.txt, markdown mirrors, MCP), the dashboard API, and in-process
// crawls — one binary sized for a single free-tier instance.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/PradSharma554/CloudAIr/server/internal/agents"
	"github.com/PradSharma554/CloudAIr/server/internal/analytics"
	"github.com/PradSharma554/CloudAIr/server/internal/config"
	"github.com/PradSharma554/CloudAIr/server/internal/crawler"
	"github.com/PradSharma554/CloudAIr/server/internal/httpapi"
	"github.com/PradSharma554/CloudAIr/server/internal/llm"
	"github.com/PradSharma554/CloudAIr/server/internal/llmstxt"
	"github.com/PradSharma554/CloudAIr/server/internal/mcpserver"
	"github.com/PradSharma554/CloudAIr/server/internal/ratelimit"
	"github.com/PradSharma554/CloudAIr/server/internal/sites"
	"github.com/PradSharma554/CloudAIr/server/internal/store"
	"github.com/PradSharma554/CloudAIr/server/internal/verify"
)

func main() {
	migrateOnly := flag.Bool("migrate-only", false, "run migrations and exit")
	seed := flag.Bool("seed", false, "insert a dev user and demo site, then exit")
	flag.Parse()

	if err := run(*migrateOnly, *seed); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(migrateOnly, seed bool) error {
	ctx := context.Background()

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	st, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if migrateOnly {
		slog.Info("migrations applied")
		return nil
	}
	if seed {
		return seedDev(ctx, st)
	}

	llmClient, err := llm.New(ctx, cfg.GeminiAPIKey, cfg.GeminiModel)
	if err != nil {
		return fmt.Errorf("gemini client: %w", err)
	}
	if !llmClient.Enabled() {
		slog.Warn("GEMINI_API_KEY not set — llms.txt will use the non-LLM fallback")
	}

	generator := llmstxt.NewGenerator(st, llmClient, cfg.PublicBaseURL)
	cr := crawler.New(st, func(ctx context.Context, site *store.Site) error {
		return generator.Generate(ctx, site)
	})

	classifier, err := agents.NewClassifier()
	if err != nil {
		return fmt.Errorf("agent signatures: %w", err)
	}

	recorder := analytics.NewRecorder(st)
	server := httpapi.NewServer(
		cfg, st, verify.New(), cr, generator, llmClient,
		mcpserver.NewManager(st, cfg.PublicBaseURL),
		classifier,
		ratelimit.NewMemoryLimiter(),
		ratelimit.NewRuleSource(st.RateLimitRuleMap),
		recorder,
	)

	// Resume crawls orphaned by the last spin-down/deploy.
	if err := cr.ResumeStalled(ctx); err != nil {
		slog.Error("resume stalled crawls", "err", err)
	}

	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "port", cfg.Port, "public_base_url", cfg.PublicBaseURL)
		errCh <- httpServer.ListenAndServe()
	}()

	// Render sends SIGTERM before spin-down: drain HTTP, flush analytics.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	select {
	case sig := <-stop:
		slog.Info("shutting down", "signal", sig.String())
	case err := <-errCh:
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		slog.Error("http shutdown", "err", err)
	}
	recorder.Close()
	return nil
}

// seedDev creates a local dev user and an unverified demo site.
func seedDev(ctx context.Context, st *store.Store) error {
	user, err := st.UpsertUser(ctx, "dev", "local", "dev@localhost", "Dev User")
	if err != nil {
		return err
	}
	token, err := sites.NewVerificationToken()
	if err != nil {
		return err
	}
	site, err := st.CreateSite(ctx, user.ID, "example.com", "example-com", token)
	if err != nil {
		slog.Warn("seed site create failed (may already exist)", "err", err)
		return nil
	}
	slog.Info("seeded", "user", user.Email, "site", site.Domain, "slug", site.Slug)
	return nil
}
