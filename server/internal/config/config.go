// Package config parses environment configuration for the CloudAIr server.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	// Port the HTTP server listens on. Render injects PORT.
	Port int
	// DatabaseURL is the Postgres connection string (Neon in prod).
	DatabaseURL string
	// APIJWTSecret is shared with the Next.js proxy that mints dashboard JWTs.
	APIJWTSecret string
	// InternalToken guards /internal/* endpoints (GitHub Actions cron).
	InternalToken string
	// GeminiAPIKey enables LLM summaries; empty engages the non-LLM fallback.
	GeminiAPIKey string
	// GeminiModel is the model used for summaries.
	GeminiModel string
	// PublicBaseURL is the externally reachable base URL of this service,
	// e.g. https://cloudair.onrender.com. Used in llms.txt and MCP URLs.
	PublicBaseURL string
	// HostSuffix, when set (e.g. ".cloudair.dev"), enables Host-header site
	// resolution: <slug><HostSuffix> resolves to the site.
	HostSuffix string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:          envInt("PORT", 8080),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		APIJWTSecret:  os.Getenv("API_JWT_SECRET"),
		InternalToken: os.Getenv("INTERNAL_TOKEN"),
		GeminiAPIKey:  os.Getenv("GEMINI_API_KEY"),
		GeminiModel:   envStr("GEMINI_MODEL", "gemini-3.1-flash-lite"),
		PublicBaseURL: envStr("PUBLIC_BASE_URL", "http://localhost:8080"),
		HostSuffix:    os.Getenv("HOST_SUFFIX"),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	return cfg, nil
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
