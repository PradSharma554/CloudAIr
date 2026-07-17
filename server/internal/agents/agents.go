// Package agents classifies incoming requests by the AI agent behind them,
// using an embedded User-Agent signature table plus heuristics.
package agents

import (
	_ "embed"
	"encoding/json"
	"strings"
)

// Class is the trust level of an identified agent. verified-agent is reserved
// for Web Bot Auth (RFC 9421 HTTP message signatures) in a later phase — the
// enum and analytics schema include it now so no migration is needed then.
type Class string

const (
	ClassVerified  Class = "verified-agent"
	ClassDeclared  Class = "declared-agent"
	ClassSuspected Class = "suspected-agent"
	ClassUnknown   Class = "unknown"
)

type Signature struct {
	Name           string   `json:"name"`
	Operator       string   `json:"operator"`
	UASubstrings   []string `json:"ua_substrings"`
	Purpose        string   `json:"purpose"`
	RespectsRobots bool     `json:"respects_robots"`
}

type Info struct {
	Class    Class
	Name     string
	Operator string
	Purpose  string
}

//go:embed signatures.json
var signaturesJSON []byte

type Classifier struct {
	signatures []Signature
}

func NewClassifier() (*Classifier, error) {
	var sigs []Signature
	if err := json.Unmarshal(signaturesJSON, &sigs); err != nil {
		return nil, err
	}
	return &Classifier{signatures: sigs}, nil
}

var suspectedMarkers = []string{
	"bot", "crawler", "spider", "scraper", "python-requests", "python/",
	"curl/", "wget/", "go-http-client", "httpx", "aiohttp", "axios",
	"node-fetch", "libwww", "java/", "okhttp",
}

// Classify inspects the User-Agent (and Accept-Language absence) to decide
// what kind of visitor this is.
func (c *Classifier) Classify(userAgent, acceptLanguage string) Info {
	ua := strings.ToLower(userAgent)
	for _, sig := range c.signatures {
		for _, sub := range sig.UASubstrings {
			if strings.Contains(ua, strings.ToLower(sub)) {
				return Info{Class: ClassDeclared, Name: sig.Name, Operator: sig.Operator, Purpose: sig.Purpose}
			}
		}
	}
	for _, marker := range suspectedMarkers {
		if strings.Contains(ua, marker) {
			return Info{Class: ClassSuspected}
		}
	}
	if userAgent == "" || acceptLanguage == "" {
		return Info{Class: ClassSuspected}
	}
	return Info{Class: ClassUnknown}
}

func (c *Classifier) Signatures() []Signature {
	return c.signatures
}
