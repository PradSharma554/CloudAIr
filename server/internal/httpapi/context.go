package httpapi

import (
	"context"
	"net/http"

	"github.com/PradSharma554/CloudAIr/server/internal/agents"
	"github.com/PradSharma554/CloudAIr/server/internal/store"
)

type ctxKey int

const (
	ctxSite ctxKey = iota
	ctxAgent
	ctxUserID
)

func withSite(r *http.Request, site *store.Site) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxSite, site))
}

func siteFrom(r *http.Request) *store.Site {
	site, _ := r.Context().Value(ctxSite).(*store.Site)
	return site
}

func withAgent(r *http.Request, info agents.Info) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxAgent, info))
}

func agentFrom(r *http.Request) agents.Info {
	info, _ := r.Context().Value(ctxAgent).(agents.Info)
	return info
}

func withUserID(r *http.Request, id string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), ctxUserID, id))
}

func userIDFrom(r *http.Request) string {
	id, _ := r.Context().Value(ctxUserID).(string)
	return id
}
