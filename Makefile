SHELL := /bin/bash

DATABASE_URL ?= postgres://cloudair:cloudair@localhost:5433/cloudair?sslmode=disable

.PHONY: db-up db-down migrate server web test lint seed

db-up:
	docker compose up -d db

db-down:
	docker compose down

# Targets source server/.env when present; DATABASE_URL above is the fallback.
migrate:
	cd server && set -a && { [ -f .env ] && . ./.env; } ; set +a && DATABASE_URL="$${DATABASE_URL:-$(DATABASE_URL)}" go run ./cmd/cloudair -migrate-only

server:
	cd server && set -a && { [ -f .env ] && . ./.env; } ; set +a && DATABASE_URL="$${DATABASE_URL:-$(DATABASE_URL)}" go run ./cmd/cloudair

web:
	cd web && npm run dev

test:
	cd server && go test ./...

lint:
	cd server && go vet ./...

seed:
	cd server && DATABASE_URL="$(DATABASE_URL)" go run ./cmd/cloudair -seed
