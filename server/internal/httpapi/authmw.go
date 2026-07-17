package httpapi

import (
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/hashicorp/golang-lru/v2/expirable"
)

// userCache avoids a users upsert on every dashboard request; JWTs are minted
// per-request by the Next.js proxy with a 5-minute TTL.
var userCache = expirable.NewLRU[string, string](2048, nil, 5*time.Minute)

// requireAuth verifies the HS256 JWT minted by the dashboard proxy and puts
// the user ID in context, lazily creating the users row.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !found || token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
			return
		}
		claims := jwt.MapClaims{}
		_, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
			if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, jwt.ErrSignatureInvalid
			}
			return []byte(s.cfg.APIJWTSecret), nil
		}, jwt.WithExpirationRequired())
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid token"})
			return
		}
		sub, _ := claims["sub"].(string)
		provider, providerID, ok := strings.Cut(sub, ":")
		if !ok || provider == "" || providerID == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid subject"})
			return
		}
		if userID, ok := userCache.Get(sub); ok {
			next.ServeHTTP(w, withUserID(r, userID))
			return
		}
		email, _ := claims["email"].(string)
		name, _ := claims["name"].(string)
		if email == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "email claim required"})
			return
		}
		user, err := s.st.UpsertUser(r.Context(), provider, providerID, email, name)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "user upsert failed"})
			return
		}
		userCache.Add(sub, user.ID)
		next.ServeHTTP(w, withUserID(r, user.ID))
	})
}
