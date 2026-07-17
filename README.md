# CloudAIr

**The access layer between your website and AI agents.**

Register your domain and CloudAIr becomes the interface AI agents use to read
your site: an auto-generated `llms.txt`, clean markdown mirrors of every page,
and a per-site **MCP endpoint** — with agent identification, per-agent rate
limiting, and an analytics dashboard showing exactly which agents visited and
what they read. An x402-style paywall (charge agents for access) is stubbed
and coming next.

Runs **entirely on free tiers**: Go API on Render, Next.js dashboard on
Vercel, Neon Postgres, Gemini free tier for summaries. $0/month.

```
        AI agent (ChatGPT, Claude, Perplexity, …)
                 │
                 ▼
   ┌──────────────────────────────┐
   │           CloudAIr           │   identify agent → rate limit →
   │  /sites/{slug}/llms.txt      │   record analytics → (402 paywall)
   │  /sites/{slug}/pages/*       │
   │  /sites/{slug}/mcp           │
   └──────────────┬───────────────┘
                  │ crawls (robots.txt-aware, checkpointed)
                  ▼
             your website
```

## Monorepo layout

| Path | What |
|---|---|
| `server/` | Go API: crawler, llms.txt generator, MCP servers, agent ID, rate limits, analytics |
| `web/` | Next.js 15 dashboard: OAuth login, site wizard, analytics charts, settings |
| `docs/` | Architecture, agent signature maintenance, x402 design |
| `.github/workflows/` | CI + free cron (keepalive, weekly recrawl, analytics rollup) |

## Local development

Requirements: Go 1.26+, Node 18+, Docker.

```bash
# 1. Postgres
make db-up

# 2. Go API (terminal 1) — migrations run automatically on boot
cp server/.env.example server/.env   # defaults work out of the box
make server

# 3. Dashboard (terminal 2)
cp web/.env.example web/.env.local   # add OAuth creds + AUTH_SECRET
cd web && npm install && cd ..
make web
```

Without OAuth credentials you can still exercise the whole API directly — see
`docs/architecture.md` for minting a dev JWT. Without `GEMINI_API_KEY` the
llms.txt generator uses its non-LLM fallback (meta descriptions + path-based
sections), so everything works offline.

```bash
make test   # Go unit tests
make lint   # go vet
```

## Deploy (free tiers)

### 1. Neon (Postgres)
1. Create a project at [neon.tech](https://neon.tech) (free tier, 0.5 GB).
2. Copy the pooled connection string — this is `DATABASE_URL`.

### 2. Render (Go API)
1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo (uses `server/render.yaml`).
3. Set env vars: `DATABASE_URL` (Neon), `API_JWT_SECRET` (any long random
   string), `GEMINI_API_KEY` (from [aistudio.google.com](https://aistudio.google.com/apikey), optional),
   `PUBLIC_BASE_URL` (your Render URL, e.g. `https://cloudair.onrender.com` —
   set after the first deploy and redeploy).
4. Migrations run automatically on boot.

### 3. Vercel (dashboard)
1. Vercel → **New Project** → import the repo, set **Root Directory** to `web`.
2. Env vars: `AUTH_SECRET` (`openssl rand -base64 32`),
   `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`,
   `API_JWT_SECRET` (same value as Render), `BACKEND_URL` (the Render URL).
3. OAuth callback URLs: `https://<your-app>.vercel.app/api/auth/callback/google`
   and `.../callback/github`.

### 4. GitHub Actions cron (free ops)
Repo **Settings → Secrets and variables → Actions**:
- variable `BACKEND_URL` = the Render URL
- secret `INTERNAL_TOKEN` = the value Render generated

This enables the every-10-min keepalive ping (optional — delete the job to
accept cold starts instead) and the daily recrawl + analytics rollup.

## Using it (site owner)

1. Sign in, **Add site**, enter your domain.
2. Add the DNS TXT record (`_cloudair.<domain>`) or well-known file, click
   **Verify** — the first crawl starts automatically (≤50 pages, robots.txt
   respected, 1 req/s).
3. Redirect `yourdomain.com/llms.txt` → your CloudAIr llms.txt URL, and share
   the MCP endpoint in your docs:
   ```
   claude mcp add --transport http yoursite https://<render-url>/sites/<slug>/mcp
   ```
4. Watch the Analytics tab: which agents (GPTBot, ClaudeBot, PerplexityBot, …)
   visited, what they fetched, which MCP tools they called.
5. Set per-agent rate limits in Settings.

## Free-tier survival notes

- **Render spins down after 15 min idle** → crawls checkpoint to Postgres
  after every page and resume automatically on the next boot; MCP runs in
  stateless mode so spin-downs are invisible to clients.
- **Gemini quota** → 8 requests/min throttle, summaries cached by content
  hash (recrawling an unchanged site costs 0 quota), and a non-LLM fallback.
- **Neon 0.5 GB** → 200 KB/page cap, 50 pages/site, raw analytics pruned at
  30 days into permanent daily rollups. Watch `db_size_bytes` on `/healthz`.
