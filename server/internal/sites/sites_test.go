package sites

import "testing"

func TestNormalizeDomain(t *testing.T) {
	good := map[string]string{
		"example.com":                  "example.com",
		"EXAMPLE.COM":                  "example.com",
		"https://www.example.com/path": "example.com",
		"http://example.com":           "example.com",
		"docs.example.com":             "docs.example.com",
		"www.example.co.uk":            "example.co.uk",
		"  example.com  ":              "example.com",
	}
	for in, want := range good {
		got, err := NormalizeDomain(in)
		if err != nil {
			t.Errorf("NormalizeDomain(%q) error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizeDomain(%q) = %q, want %q", in, got, want)
		}
	}
	bad := []string{"", "localhost", "co.uk", "not a domain", "http://"}
	for _, in := range bad {
		if got, err := NormalizeDomain(in); err == nil {
			t.Errorf("NormalizeDomain(%q) = %q, want error", in, got)
		}
	}
}

func TestSlug(t *testing.T) {
	if got := Slug("docs.example.com"); got != "docs-example-com" {
		t.Errorf("Slug = %q, want docs-example-com", got)
	}
}

func TestNewVerificationToken(t *testing.T) {
	a, err := NewVerificationToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewVerificationToken()
	if a == b {
		t.Error("tokens should be unique")
	}
	if len(a) != len("cloudair-verify=")+32 {
		t.Errorf("unexpected token format: %q", a)
	}
}
