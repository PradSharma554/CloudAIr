package agents

import "testing"

func TestClassify(t *testing.T) {
	c, err := NewClassifier()
	if err != nil {
		t.Fatalf("NewClassifier: %v", err)
	}
	cases := []struct {
		ua        string
		lang      string
		wantClass Class
		wantName  string
	}{
		{"Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "", ClassDeclared, "GPTBot"},
		{"Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "", ClassDeclared, "ClaudeBot"},
		{"Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "", ClassDeclared, "PerplexityBot"},
		{"curl/8.4.0", "", ClassSuspected, ""},
		{"python-requests/2.31", "", ClassSuspected, ""},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "en-US", ClassUnknown, ""},
		{"Mozilla/5.0 (Macintosh) Safari/605.1.15", "", ClassSuspected, ""}, // browser UA but no Accept-Language
		{"", "", ClassSuspected, ""},
	}
	for _, tc := range cases {
		got := c.Classify(tc.ua, tc.lang)
		if got.Class != tc.wantClass || got.Name != tc.wantName {
			t.Errorf("Classify(%q, %q) = {%s %q}, want {%s %q}",
				tc.ua, tc.lang, got.Class, got.Name, tc.wantClass, tc.wantName)
		}
	}
}

func TestSignaturesLoad(t *testing.T) {
	c, err := NewClassifier()
	if err != nil {
		t.Fatalf("NewClassifier: %v", err)
	}
	if len(c.Signatures()) < 20 {
		t.Errorf("expected at least 20 agent signatures, got %d", len(c.Signatures()))
	}
}
