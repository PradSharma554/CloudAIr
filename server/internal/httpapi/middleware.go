package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/PradSharma554/CloudAIr/server/internal/store"
	"github.com/PradSharma554/CloudAIr/server/internal/x402"
)

// statusWriter captures the response status for analytics.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Flush keeps streaming (llms-full.txt, SSE) working through the wrapper.
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// agentIdentify classifies the visitor and stores the result in context.
func (s *Server) agentIdentify(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := s.classifier.Classify(r.UserAgent(), r.Header.Get("Accept-Language"))
		// Only agents speak MCP; upgrade unidentified MCP traffic to declared.
		if strings.HasSuffix(r.URL.Path, "/mcp") && info.Class != "declared-agent" && info.Class != "verified-agent" {
			info.Class = "declared-agent"
			if info.Name == "" {
				info.Name = mcpClientName(r)
			}
		}
		next.ServeHTTP(w, withAgent(r, info))
	})
}

// mcpClientName pulls clientInfo.name out of an MCP initialize request so the
// dashboard can show which MCP client visited.
func mcpClientName(r *http.Request) string {
	if r.Method != http.MethodPost {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return ""
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var msg struct {
		Method string `json:"method"`
		Params struct {
			ClientInfo struct {
				Name string `json:"name"`
			} `json:"clientInfo"`
		} `json:"params"`
	}
	if json.Unmarshal(body, &msg) != nil || msg.Method != "initialize" {
		return ""
	}
	return msg.Params.ClientInfo.Name
}

// rateLimit enforces per-(site, agent) token buckets with per-site rules.
func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		site := siteFrom(r)
		agent := agentFrom(r)
		subject := agent.Name
		if subject == "" {
			subject = string(agent.Class)
		}
		rpm, burst := s.rules.Resolve(r.Context(), site.ID, agent.Name, string(agent.Class))
		ok, retryAfter := s.limiter.Allow(site.ID+"|"+subject, rpm, burst)
		if ok {
			next.ServeHTTP(w, r)
			return
		}
		secs := int(retryAfter.Seconds()) + 1
		w.Header().Set("Retry-After", fmt.Sprintf("%d", secs))
		if strings.HasSuffix(r.URL.Path, "/mcp") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": nil,
				"error": map[string]any{"code": -32000, "message": fmt.Sprintf("rate limited, retry after %ds", secs)},
			})
			return
		}
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "rate limited", "retry_after_seconds": secs,
		})
	})
}

// paywall applies the x402 stub when the site has monetization enabled.
func (s *Server) paywall(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		x402.Middleware(siteFrom(r))(next).ServeHTTP(w, r)
	})
}

// record writes one analytics event per agent-facing request.
func (s *Server) record(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		kind, toolName := classifyRequest(r)
		next.ServeHTTP(sw, r)

		site := siteFrom(r)
		agent := agentFrom(r)
		status := sw.status
		if status == 0 {
			status = http.StatusOK
		}
		s.recorder.Record(store.AgentRequest{
			SiteID:     site.ID,
			AgentClass: string(agent.Class),
			AgentName:  agent.Name,
			Kind:       kind,
			ToolName:   toolName,
			Path:       r.URL.Path,
			StatusCode: status,
			LatencyMS:  int(time.Since(start).Milliseconds()),
			UserAgent:  r.UserAgent(),
		})
	})
}

// classifyRequest determines the analytics event kind, peeking into MCP
// JSON-RPC bodies to attribute tool calls.
func classifyRequest(r *http.Request) (kind, toolName string) {
	path := r.URL.Path
	switch {
	case strings.HasSuffix(path, "/llms.txt"), strings.HasSuffix(path, "/llms-full.txt"):
		return "llms_txt", ""
	case strings.HasSuffix(path, "/mcp"):
		return "mcp_tool", mcpMethodOrTool(r)
	default:
		return "page", ""
	}
}

func mcpMethodOrTool(r *http.Request) string {
	if r.Method != http.MethodPost {
		return ""
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return ""
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var msg struct {
		Method string `json:"method"`
		Params struct {
			Name string `json:"name"`
		} `json:"params"`
	}
	if json.Unmarshal(body, &msg) != nil {
		return ""
	}
	if msg.Method == "tools/call" && msg.Params.Name != "" {
		return msg.Params.Name
	}
	return msg.Method
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
