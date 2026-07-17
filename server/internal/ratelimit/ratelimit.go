// Package ratelimit provides per-(site, agent) token-bucket rate limiting.
//
// Buckets live in process memory. On Render's free tier this is correct, not
// just acceptable: there is exactly one instance, so there is no replica to
// disagree with. Limits reset on spin-down, which only errs permissive. The
// Limiter interface is the seam for a Redis-backed implementation when
// scaling to multiple instances later.
package ratelimit

import (
	"context"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"golang.org/x/time/rate"
)

type Limiter interface {
	// Allow reports whether the request identified by key may proceed under
	// the given requests-per-minute and burst, and if not, how long to wait.
	Allow(key string, rpm, burst int) (ok bool, retryAfter time.Duration)
}

type MemoryLimiter struct {
	buckets *lru.Cache[string, *rate.Limiter]
}

func NewMemoryLimiter() *MemoryLimiter {
	// 10k buckets ≈ a few MB — bounded memory on a 512MB instance.
	cache, _ := lru.New[string, *rate.Limiter](10000)
	return &MemoryLimiter{buckets: cache}
}

func (m *MemoryLimiter) Allow(key string, rpm, burst int) (bool, time.Duration) {
	if rpm <= 0 {
		rpm = 60
	}
	if burst <= 0 {
		burst = 10
	}
	limit := rate.Limit(float64(rpm) / 60.0)
	limiter, ok := m.buckets.Get(key)
	if !ok {
		limiter = rate.NewLimiter(limit, burst)
		m.buckets.Add(key, limiter)
	} else if limiter.Limit() != limit || limiter.Burst() != burst {
		// Rules changed since this bucket was created — apply the new
		// parameters instead of serving stale limits until eviction.
		limiter.SetLimit(limit)
		limiter.SetBurst(burst)
	}
	res := limiter.Reserve()
	if !res.OK() {
		return false, time.Minute
	}
	delay := res.Delay()
	if delay > 0 {
		res.Cancel()
		return false, delay
	}
	return true, 0
}

// RuleSource resolves the effective (rpm, burst) for a site + agent, caching
// DB rules for 60s.
type RuleSource struct {
	fetch func(ctx context.Context, siteID string) (map[string][2]int, error)

	mu    sync.Mutex
	cache map[string]cachedRules
}

type cachedRules struct {
	rules   map[string][2]int // key: "class:<class>" | "agent:<name>" | "site:*"
	expires time.Time
}

const (
	DefaultRPM   = 60
	DefaultBurst = 10
)

func NewRuleSource(fetch func(ctx context.Context, siteID string) (map[string][2]int, error)) *RuleSource {
	return &RuleSource{fetch: fetch, cache: map[string]cachedRules{}}
}

// Resolve applies precedence: exact agent name → agent class → site '*'
// default → global default.
func (r *RuleSource) Resolve(ctx context.Context, siteID, agentName, agentClass string) (rpm, burst int) {
	rules := r.rulesFor(ctx, siteID)
	if agentName != "" {
		if v, ok := rules["agent:"+agentName]; ok {
			return v[0], v[1]
		}
	}
	if v, ok := rules["class:"+agentClass]; ok {
		return v[0], v[1]
	}
	if v, ok := rules["site:*"]; ok {
		return v[0], v[1]
	}
	return DefaultRPM, DefaultBurst
}

// Invalidate drops the cached rules for a site (called when rules change).
func (r *RuleSource) Invalidate(siteID string) {
	r.mu.Lock()
	delete(r.cache, siteID)
	r.mu.Unlock()
}

func (r *RuleSource) rulesFor(ctx context.Context, siteID string) map[string][2]int {
	r.mu.Lock()
	entry, ok := r.cache[siteID]
	r.mu.Unlock()
	if ok && time.Now().Before(entry.expires) {
		return entry.rules
	}
	rules, err := r.fetch(ctx, siteID)
	if err != nil || rules == nil {
		rules = map[string][2]int{}
	}
	r.mu.Lock()
	r.cache[siteID] = cachedRules{rules: rules, expires: time.Now().Add(60 * time.Second)}
	r.mu.Unlock()
	return rules
}
