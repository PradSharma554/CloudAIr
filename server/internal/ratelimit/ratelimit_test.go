package ratelimit

import (
	"context"
	"testing"
)

func TestMemoryLimiterBurstThenBlock(t *testing.T) {
	l := NewMemoryLimiter()
	allowed := 0
	for i := 0; i < 20; i++ {
		if ok, _ := l.Allow("site|GPTBot", 60, 5); ok {
			allowed++
		}
	}
	// Burst of 5 plus at most a token or two refilled during the loop.
	if allowed < 5 || allowed > 7 {
		t.Errorf("allowed %d requests, want ~5 (burst)", allowed)
	}
	if ok, retryAfter := l.Allow("site|GPTBot", 60, 5); ok || retryAfter <= 0 {
		t.Errorf("expected block with positive retry-after, got ok=%v retry=%v", ok, retryAfter)
	}
	// A different key has its own bucket.
	if ok, _ := l.Allow("site|ClaudeBot", 60, 5); !ok {
		t.Error("different key should have a fresh bucket")
	}
}

func TestRuleSourcePrecedence(t *testing.T) {
	rules := map[string][2]int{
		"agent:GPTBot":          {5, 1},
		"class:declared-agent":  {30, 5},
		"site:*":                {100, 20},
	}
	src := NewRuleSource(func(ctx context.Context, siteID string) (map[string][2]int, error) {
		return rules, nil
	})
	ctx := context.Background()

	if rpm, _ := src.Resolve(ctx, "s1", "GPTBot", "declared-agent"); rpm != 5 {
		t.Errorf("exact agent rule: got rpm=%d, want 5", rpm)
	}
	if rpm, _ := src.Resolve(ctx, "s1", "ClaudeBot", "declared-agent"); rpm != 30 {
		t.Errorf("class rule: got rpm=%d, want 30", rpm)
	}
	if rpm, _ := src.Resolve(ctx, "s1", "", "unknown"); rpm != 100 {
		t.Errorf("site wildcard: got rpm=%d, want 100", rpm)
	}

	empty := NewRuleSource(func(ctx context.Context, siteID string) (map[string][2]int, error) {
		return map[string][2]int{}, nil
	})
	if rpm, burst := empty.Resolve(ctx, "s1", "", "unknown"); rpm != DefaultRPM || burst != DefaultBurst {
		t.Errorf("global default: got rpm=%d burst=%d, want %d/%d", rpm, burst, DefaultRPM, DefaultBurst)
	}
}

func TestMemoryLimiterAppliesRuleChanges(t *testing.T) {
	l := NewMemoryLimiter()
	// Bucket created at generous defaults…
	if ok, _ := l.Allow("s|GPTBot", 60, 10); !ok {
		t.Fatal("first request should pass")
	}
	// …then the site owner tightens the rule; the existing bucket must obey.
	allowed := 0
	for i := 0; i < 10; i++ {
		if ok, _ := l.Allow("s|GPTBot", 2, 2); ok {
			allowed++
		}
	}
	if allowed > 2 {
		t.Errorf("tightened rule allowed %d requests, want <= 2", allowed)
	}
}
