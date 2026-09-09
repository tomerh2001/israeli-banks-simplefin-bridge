package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

const leaseDuration = 180 * time.Second
const maxConsumed = 2048

var footer = regexp.MustCompile(`\n@www\.clalbit\.co\.il #([0-9]{6})$`)
var bodyCode = regexp.MustCompile(`קוד האימות לחשבון האישי שלך הוא:\s*([0-9]{6})(?:\s|$)`)

func clalCode(text string) string {
	if len(text) > 4096 {
		return ""
	}
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	end := footer.FindStringSubmatch(text)
	start := bodyCode.FindAllStringSubmatch(text, -1)
	if len(end) != 2 || len(start) != 1 || start[0][1] != end[1] {
		return ""
	}
	return end[1]
}

func messageHash(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

type consumedEntry struct {
	Hash string    `json:"hash"`
	At   time.Time `json:"at"`
}
type lease struct {
	ID          string `json:"requestId"`
	provider    string
	ArmedAt     time.Time `json:"armedAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
	code        string
	messageHash string
	delivered   bool
	ambiguous   bool
}

type broker struct {
	mu           sync.Mutex
	now          func() time.Time
	online       bool
	health       string
	terminal     bool
	request      *lease
	changed      chan struct{}
	providers    map[string]*providerRule
	seen         map[string]time.Time
	consumed     []consumedEntry
	consumedPath string
	persist      func(string, any) error
	waitDuration time.Duration
	verifyReady  func(context.Context) bool
}

func newBroker(senders []string, consumedPath string) (*broker, error) {
	b := &broker{now: time.Now, health: "connecting", changed: make(chan struct{}), providers: map[string]*providerRule{}, seen: map[string]time.Time{}, consumedPath: consumedPath, persist: writePrivateJSON, waitDuration: 20 * time.Second}
	if err := b.configureProvider(clalProvider, senders, clalCode); err != nil {
		return nil, err
	}
	if err := readPrivateJSON(consumedPath, &b.consumed); err != nil {
		// Missing is the only permitted empty initial state.
		if !isMissing(consumedPath) {
			return nil, errPrivateState
		}
	}
	if len(b.consumed) > maxConsumed {
		return nil, errPrivateState
	}
	for _, entry := range b.consumed {
		if len(entry.Hash) != 64 || entry.At.IsZero() {
			return nil, errPrivateState
		}
	}
	return b, nil
}

func (b *broker) signalLocked() { close(b.changed); b.changed = make(chan struct{}) }
func (b *broker) setHealth(online bool, state string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.terminal && state != "stopping" {
		return
	}
	if state == "state_write_failed" || state == "capacity_exceeded" || state == "candidate_overflow" {
		b.terminal = true
	}
	b.online, b.health = online, state
	// A disconnect invalidates pending/delivered requests. Never carry an OTP across reconnects.
	if !online {
		b.request = nil
	}
	b.signalLocked()
}

// Only already parsed, incoming, non-backfilled candidate messages reach this function.
func (b *broker) accept(provider, id, sender, code string, timestamp time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	hash := messageHash(id)
	rule := b.providers[provider]
	if rule == nil || rule.code == nil || b.request == nil || b.request.provider != provider {
		return
	}
	if id == "" || !rule.senders[sender] || !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code) {
		return
	}
	if _, seen := b.seen[hash]; seen {
		return
	}
	// Bound in-memory candidate deduplication without retaining SMS contents or unrelated messages.
	for key, at := range b.seen {
		if now.Sub(at) > 10*time.Minute {
			delete(b.seen, key)
		}
	}
	if len(b.seen) >= maxConsumed {
		b.terminal = true
		b.online = false
		b.health = "capacity_exceeded"
		b.request = nil
		b.signalLocked()
		return
	}
	b.seen[hash] = now
	for _, entry := range b.consumed {
		if entry.Hash == hash {
			return
		}
	}
	r := b.request
	if !b.online || r == nil || r.delivered || r.ambiguous || !now.Before(r.ExpiresAt) || timestamp.IsZero() || timestamp.Before(r.ArmedAt) || timestamp.After(now.Add(time.Second)) {
		return
	}
	if r.messageHash != "" && r.messageHash != hash {
		r.code = ""
		r.ambiguous = true
		b.signalLocked()
		return
	}
	r.code, r.messageHash = code, hash
	b.signalLocked()
}

func (b *broker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	// Browser-origin requests are never an authorized socket client.
	if r.Header.Get("Origin") != "" {
		reply(w, 403, map[string]string{"error": "forbidden"})
		return
	}
	if r.URL.RawQuery != "" {
		reply(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		b.replyHealth(w)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || len(parts) > 4 || parts[0] != "v1" || (parts[1] != clalProvider && parts[1] != bestInvestProvider) {
		reply(w, 404, map[string]string{"error": "not_found"})
		return
	}
	provider := parts[1]
	if !b.providerEnabled(provider) {
		reply(w, 503, map[string]string{"error": "receiver_unavailable"})
		return
	}
	if len(parts) == 3 && parts[2] == "healthz" && r.Method == "GET" {
		b.replyHealth(w)
		return
	}
	if len(parts) == 3 && parts[2] == "arm" && r.Method == "POST" {
		if !emptyJSON(w, r) {
			return
		}
		b.arm(w, r, provider)
		return
	}
	if len(parts[2]) != 48 {
		reply(w, 404, map[string]string{"error": "not_found"})
		return
	}
	if len(parts) == 3 && r.Method == "DELETE" {
		b.mu.Lock()
		if b.request != nil && b.request.provider == provider && b.request.ID == parts[2] {
			b.request = nil
			b.signalLocked()
		}
		b.mu.Unlock()
		w.WriteHeader(204)
		return
	}
	if len(parts) == 4 && parts[3] == "wait" && r.Method == "POST" {
		if !emptyJSON(w, r) {
			return
		}
		b.wait(w, r, provider, parts[2])
		return
	}
	reply(w, 404, map[string]string{"error": "not_found"})
}

// Provider routes reach this only after verifying their configured sender and
// matcher. Reading health never acquires a lease or asks the phone for a code.
func (b *broker) replyHealth(w http.ResponseWriter) {
	b.mu.Lock()
	state, online := b.health, b.online
	b.mu.Unlock()
	reply(w, 200, map[string]any{"online": online, "state": state})
}

func reply(w http.ResponseWriter, status int, value any) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func emptyJSON(w http.ResponseWriter, r *http.Request) bool {
	defer r.Body.Close()
	var body map[string]json.RawMessage
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128))
	if dec.Decode(&body) != nil || body == nil || len(body) != 0 {
		reply(w, 400, map[string]string{"error": "invalid_request"})
		return false
	}
	var extra any
	if !errors.Is(dec.Decode(&extra), io.EOF) {
		reply(w, 400, map[string]string{"error": "invalid_request"})
		return false
	}
	return true
}

func (b *broker) arm(w http.ResponseWriter, req *http.Request, provider string) {
	// Confirm phone reachability before the caller requests an SMS. This performs
	// no message read and stays inside the adapter's ten-second arm deadline.
	b.mu.Lock()
	canCheck := b.online && (b.request == nil || !b.now().Before(b.request.ExpiresAt))
	b.mu.Unlock()
	if canCheck && b.verifyReady != nil {
		ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
		ready := b.verifyReady(ctx)
		cancel()
		if !ready {
			b.setHealth(false, "phone_unavailable")
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now().UTC()
	if !b.online {
		reply(w, 503, map[string]string{"error": "receiver_unavailable"})
		return
	}
	if b.request != nil && now.Before(b.request.ExpiresAt) {
		reply(w, 409, map[string]string{"error": "request_active"})
		return
	}
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		reply(w, 503, map[string]string{"error": "receiver_unavailable"})
		return
	}
	b.request = &lease{ID: hex.EncodeToString(random[:]), provider: provider, ArmedAt: now, ExpiresAt: now.Add(leaseDuration)}
	b.signalLocked()
	reply(w, 201, b.request)
}

func (b *broker) wait(w http.ResponseWriter, req *http.Request, provider, id string) {
	timer := time.NewTimer(b.waitDuration)
	defer timer.Stop()
	for {
		b.mu.Lock()
		now := b.now().UTC()
		r := b.request
		if !b.online {
			b.mu.Unlock()
			reply(w, 503, map[string]string{"error": "receiver_unavailable"})
			return
		}
		if r == nil || r.provider != provider || r.ID != id || !now.Before(r.ExpiresAt) || r.delivered {
			b.mu.Unlock()
			reply(w, 410, map[string]string{"error": "request_gone"})
			return
		}
		if r.ambiguous {
			b.mu.Unlock()
			reply(w, 409, map[string]string{"error": "ambiguous_code"})
			return
		}
		if r.code != "" {
			kept := make([]consumedEntry, 0, len(b.consumed)+1)
			for _, entry := range b.consumed {
				if now.Sub(entry.At) < 7*24*time.Hour {
					kept = append(kept, entry)
				}
			}
			if len(kept) >= maxConsumed {
				b.mu.Unlock()
				reply(w, 503, map[string]string{"error": "receiver_unavailable"})
				return
			}
			kept = append(kept, consumedEntry{Hash: r.messageHash, At: now})
			if err := b.persist(b.consumedPath, kept); err != nil {
				b.terminal = true
				b.online = false
				b.health = "state_write_failed"
				b.request = nil
				b.signalLocked()
				b.mu.Unlock()
				reply(w, 503, map[string]string{"error": "receiver_unavailable"})
				return
			}
			b.consumed = kept
			code := r.code
			r.code = ""
			r.delivered = true
			result := map[string]any{"requestId": r.ID, "code": code, "expiresAt": r.ExpiresAt}
			b.mu.Unlock()
			reply(w, 200, result)
			return
		}
		changed := b.changed
		b.mu.Unlock()
		select {
		case <-req.Context().Done():
			return
		case <-timer.C:
			reply(w, 202, map[string]string{"requestId": id, "status": "pending"})
			return
		case <-changed:
		}
	}
}
