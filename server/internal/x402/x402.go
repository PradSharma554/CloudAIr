// Package x402 is the paywall seam: a design-only stub for v1 that returns
// HTTP 402 with an x402-spec payment-required body when a site has
// monetization enabled and the request carries no X-PAYMENT header.
//
// The real integration (verifying X-PAYMENT via a facilitator, settling on
// Base) plugs into this same middleware later — see docs/x402.md.
package x402

import (
	"encoding/json"
	"net/http"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

type PaymentRequirements struct {
	Scheme            string `json:"scheme"`
	Network           string `json:"network"`
	MaxAmountRequired string `json:"maxAmountRequired"`
	Resource          string `json:"resource"`
	Description       string `json:"description"`
	PayTo             string `json:"payTo"`
	Asset             string `json:"asset"`
	MimeType          string `json:"mimeType"`
}

type PaymentRequired struct {
	X402Version int                   `json:"x402Version"`
	Error       string                `json:"error"`
	Accepts     []PaymentRequirements `json:"accepts"`
}

// Middleware enforces the (stub) paywall for a resolved site.
func Middleware(site *store.Site) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mon := site.Settings.Monetization
			if !mon.Enabled || r.Header.Get("X-PAYMENT") != "" {
				// v1 stub: any X-PAYMENT header passes; verification via a
				// facilitator is the later phase.
				next.ServeHTTP(w, r)
				return
			}
			network := mon.Network
			if network == "" {
				network = "base-sepolia"
			}
			body := PaymentRequired{
				X402Version: 1,
				Error:       "payment required to access this resource",
				Accepts: []PaymentRequirements{{
					Scheme:            "exact",
					Network:           network,
					MaxAmountRequired: usdToUSDCAtomic(mon.PriceUSD),
					Resource:          r.URL.String(),
					Description:       "Access to " + site.Domain + " agent content via CloudAIr",
					PayTo:             mon.PayTo,
					Asset:             "USDC",
					MimeType:          "text/markdown",
				}},
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusPaymentRequired)
			_ = json.NewEncoder(w).Encode(body)
		})
	}
}

// usdToUSDCAtomic renders a USD price in USDC atomic units (6 decimals).
func usdToUSDCAtomic(usd float64) string {
	if usd <= 0 {
		usd = 0.01
	}
	atomic := int64(usd * 1e6)
	return jsonNumber(atomic)
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
