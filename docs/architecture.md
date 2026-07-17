# CloudAIr architecture

One Go binary (`server/cmd/cloudair`) serves three surfaces:

1. **Agent-facing site endpoints** — `/sites/{slug}/llms.txt`,
   `/sites/{slug}/llms-full.txt`, `/sites/{slug}/pages/*` (markdown mirrors),
   `/sites/{slug}/mcp` (Streamable HTTP MCP, stateless).
2. **Dashboard API** — `/api/v1/*`, JWT-authenticated, called only by the
   Next.js proxy route.
3. **Internal** — `/healthz`, `/internal/recrawl` (cron).

## The SiteResolver seam (reverse-proxy mode later)

`internal/httpapi/resolver.go` defines:

```go
type SiteResolver interface {
    Resolve(r *http.Request) (site *store.Site, rest string, ok bool)
}
```

- `PathResolver` matches `/sites/{slug}/...` (MVP hosted-endpoints mode).
- `HostResolver` matches `<slug><HOST_SUFFIX>` hosts; `hostRewrite` in
  `server.go` canonicalizes those requests onto the path form, so one router
  serves both modes. Set `HOST_SUFFIX=.yourdomain.dev` to enable.
- Full reverse-proxy mode later = HostResolver for customer domains + a
  catch-all handler that forwards non-agent traffic to the origin. No
  downstream handler parses URLs for the site — they read it from context.

Agent-facing middleware chain (in order):
`siteCtx → agentIdentify → rateLimit → record → paywall → handler`

## Auth bridge (why the Go API never sees Auth.js cookies)

Auth.js v5 session cookies are **encrypted JWEs**, not verifiable JWTs.
Instead of sharing Auth.js internals with Go, the dashboard proxies every API
call through `web/app/api/backend/[...path]/route.ts`, which reads the session
server-side and mints a **5-minute HS256 JWT** (sub = `provider:providerId`)
signed with the shared `API_JWT_SECRET`. The Go side
(`internal/httpapi/authmw.go`) verifies it and lazily upserts the user row.

### Minting a dev JWT (API testing without OAuth)

```bash
cd web && node -e "
const { SignJWT } = require('jose');
new SignJWT({ email: 'dev@localhost', name: 'Dev' })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('dev:local')
  .setIssuedAt().setExpirationTime('30m')
  .sign(new TextEncoder().encode('dev-secret-change-me'))
  .then(console.log);"
# then: curl -H "Authorization: Bearer <jwt>" localhost:8080/api/v1/sites
```

## Crawler lifecycle (Render free tier)

Crawls run as goroutines inside the web service (no workers on the free
tier). After **every page** the crawler upserts the page row and writes a
checkpoint (`crawls.checkpoint`: remaining frontier + visited set) plus a
heartbeat. If the instance dies, the boot-time reaper flips `running` crawls
with heartbeats older than 2 minutes to `stalled` and resumes them from the
checkpoint. Verified end-to-end: a crawl killed at page 13 resumed at page 13.

After fetching, the post-crawl hook summarizes changed pages via Gemini
(8 rpm throttle, cached by content hash) and renders llms.txt; a heartbeat
ticker keeps the crawl alive during the summarization minutes. If Gemini is
unavailable, the fallback (meta descriptions + path-segment sections) renders
instead — llms.txt generation never fails on quota.

## Analytics pipeline

Middleware → buffered channel (cap 1000, drop-on-full) → single writer
goroutine → `pgx.CopyFrom` batch every 5 s / 100 events → flushed on SIGTERM.
The daily cron hit rolls raw events into `agent_requests_daily` and prunes
raw rows older than 30 days.

## Agent identification

`internal/agents/signatures.json` (embedded, ~30 entries) maps User-Agent
substrings to agent names/operators/purposes. Classes:

- `declared-agent` — UA matches the table, or the request speaks MCP
  (clientInfo.name is recorded as the agent name)
- `suspected-agent` — bot-ish UA heuristics or missing Accept-Language
- `unknown` — everything else
- `verified-agent` — reserved for Web Bot Auth (RFC 9421 HTTP message
  signatures); enum and analytics schema already include it

To add a signature, edit the JSON — no code changes needed.

## Rate limiting

In-memory token buckets (`x/time/rate`) in an LRU keyed by
`{siteID}|{agentName-or-class}`. Per-site rules in Postgres, cached 60 s,
precedence: exact agent → class → site `*` → global default (60 rpm/burst 10).
Rule changes apply to live buckets via SetLimit/SetBurst. Single-instance
in-memory is *correct* on Render free (n=1); the `Limiter` interface is the
seam for a Redis implementation when scaling out.
