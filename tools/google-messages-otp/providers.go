package main

import (
	"errors"
	"strings"
	"time"
)

const clalProvider = "clal"
const bestInvestProvider = "best-invest"

type providerRule struct {
	senders map[string]bool
	code    func(string) string
}

// Sender identities come only from private, explicitly verified configuration.
// Rules are installed before serving and are not caller-selectable request fields.
func (b *broker) configureProvider(provider string, senders []string, code func(string) string) error {
	if provider != clalProvider && provider != bestInvestProvider {
		return errors.New("invalid provider configuration")
	}
	allowed := map[string]bool{}
	for _, sender := range senders {
		if sender == "" || sender != strings.TrimSpace(sender) || len(sender) > 100 {
			return errors.New("invalid sender configuration")
		}
		allowed[sender] = true
	}
	if len(allowed) == 0 {
		return errors.New("provider sender is not configured")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.providers[provider]; exists {
		return errors.New("provider already configured")
	}
	b.providers[provider] = &providerRule{senders: allowed, code: code}
	return nil
}

// Fail closed until a controlled Best Invest SMS establishes its exact template.
// A sender allowlist alone cannot enable this provider or reuse Clal's matcher.
func bestInvestMatcher() func(string) string {
	return nil
}

func (b *broker) providerEnabled(provider string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	rule := b.providers[provider]
	return rule != nil && rule.code != nil
}

func (b *broker) candidateRule() (string, func(string) string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	request := b.request
	if !b.online || request == nil || request.delivered || request.ambiguous || !b.now().Before(request.ExpiresAt) {
		return "", nil, false
	}
	rule := b.providers[request.provider]
	if rule == nil || rule.code == nil {
		return "", nil, false
	}
	return request.provider, rule.code, true
}

// Only the owning provider may resolve candidate sender metadata.
func (b *broker) eligible(provider, id string, timestamp time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	return b.online && b.request != nil && b.request.provider == provider && !b.request.delivered && !b.request.ambiguous && now.Before(b.request.ExpiresAt) && !timestamp.Before(b.request.ArmedAt) && !timestamp.After(now.Add(time.Second)) && id != ""
}
