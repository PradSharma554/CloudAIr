// Package sites handles site registration: domain normalization, slug
// generation, and verification tokens.
package sites

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// NormalizeDomain accepts what users paste ("https://www.Example.com/path",
// "example.com") and returns the registrable domain, lowercased.
func NormalizeDomain(input string) (string, error) {
	input = strings.TrimSpace(strings.ToLower(input))
	if input == "" {
		return "", fmt.Errorf("domain is required")
	}
	if strings.Contains(input, "://") {
		u, err := url.Parse(input)
		if err != nil || u.Hostname() == "" {
			return "", fmt.Errorf("invalid URL")
		}
		input = u.Hostname()
	}
	input = strings.TrimSuffix(strings.Split(input, "/")[0], ".")
	input = strings.TrimPrefix(input, "www.")
	if !strings.Contains(input, ".") || strings.ContainsAny(input, " :@") {
		return "", fmt.Errorf("invalid domain %q", input)
	}
	// Reject bare public suffixes like "co.uk"; allow subdomains (docs.example.com).
	if suffix, _ := publicsuffix.PublicSuffix(input); suffix == input {
		return "", fmt.Errorf("%q is not a registrable domain", input)
	}
	return input, nil
}

// Slug converts a domain into a URL/subdomain-safe label: docs.example.com →
// docs-example-com. Doubles as the future <slug>.cloudair.dev subdomain.
func Slug(domain string) string {
	return strings.NewReplacer(".", "-", "_", "-").Replace(domain)
}

func NewVerificationToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "cloudair-verify=" + hex.EncodeToString(b), nil
}
