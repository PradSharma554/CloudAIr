// Package verify proves site ownership via DNS TXT record (primary) or a
// well-known file (fallback), like Search Console.
package verify

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	MethodDNS  = "dns"
	MethodFile = "file"
)

type Verifier struct {
	resolver *net.Resolver
	client   *http.Client
}

func New() *Verifier {
	return &Verifier{
		// Public resolver dodges local DNS caching of the freshly-created TXT record.
		resolver: &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: 5 * time.Second}
				return d.DialContext(ctx, network, "8.8.8.8:53")
			},
		},
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

// Check tries DNS TXT first, then the well-known file. Returns the method
// that succeeded, or an error describing both failures.
func (v *Verifier) Check(ctx context.Context, domain, token string) (string, error) {
	dnsErr := v.checkDNS(ctx, domain, token)
	if dnsErr == nil {
		return MethodDNS, nil
	}
	fileErr := v.checkFile(ctx, domain, token)
	if fileErr == nil {
		return MethodFile, nil
	}
	return "", fmt.Errorf("dns: %v; file: %v", dnsErr, fileErr)
}

func (v *Verifier) checkDNS(ctx context.Context, domain, token string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	records, err := v.resolver.LookupTXT(ctx, "_cloudair."+domain)
	if err != nil {
		return fmt.Errorf("TXT lookup for _cloudair.%s failed: %w", domain, err)
	}
	for _, r := range records {
		if strings.TrimSpace(r) == token {
			return nil
		}
	}
	return fmt.Errorf("no matching TXT record at _cloudair.%s", domain)
}

func (v *Verifier) checkFile(ctx context.Context, domain, token string) error {
	url := "https://" + domain + "/.well-known/cloudair-verify.txt"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "CloudAIrBot/1.0 (+ownership-verification)")
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(body)) != token {
		return fmt.Errorf("%s content does not match token", url)
	}
	return nil
}
