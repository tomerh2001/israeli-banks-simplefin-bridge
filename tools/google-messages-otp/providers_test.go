package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Deliberately synthetic test grammar; it is not an asserted Hachshara SMS template.
const syntheticBestText = "TEST ONLY BEST INVEST OTP: 234567"

// Verified grammar with a synthetic code; no captured message enters fixtures.
const bestInvestText = "סיסמה חד פעמית לכניסה לאתר היא 123456\n                            \n@customers.hcsra.co.il #123456"

func TestBestInvestTemplate(t *testing.T) {
	for _, input := range []string{
		bestInvestText,
		strings.ReplaceAll(bestInvestText, "\n", "\r\n"),
		strings.Replace(bestInvestText, "\n                            \n", "\n\t\n", 1),
		strings.Replace(bestInvestText, "\n                            \n", "\n", 1),
		" \n" + bestInvestText + "\n\t",
	} {
		if bestInvestCode(input) != "123456" {
			t.Fatal("verified template rejected")
		}
	}
	for _, input := range []string{
		strings.Replace(bestInvestText, "#123456", "#654321", 1),
		strings.Replace(bestInvestText, "customers.hcsra.co.il", "customers.hcsra.co.il.attacker.test", 1),
		strings.Replace(bestInvestText, "customers.hcsra.co.il", "www.clalbit.co.il", 1),
		strings.ReplaceAll(bestInvestText, "123456", "１２３４５６"),
		strings.ReplaceAll(bestInvestText, "123456", "12345"),
		strings.ReplaceAll(bestInvestText, "123456", "1234567"),
		strings.Replace(bestInvestText, "לאתר", "לאתר אחר", 1),
		strings.Replace(bestInvestText, "\n", "\r", 1),
		bestInvestText + "\nextra footer",
		"extra prefix\n" + bestInvestText,
		bestInvestText + "\n" + bestInvestText,
		bestInvestText + "\n654321",
		strings.Repeat(" ", 4097) + bestInvestText,
		"123456", "@customers.hcsra.co.il #123456",
		"סיסמה חד פעמית לכניסה לאתר היא 123456", textCode, syntheticBestText,
	} {
		if bestInvestCode(input) != "" {
			t.Fatal("unverified template accepted")
		}
	}
}

func syntheticBestCode(text string) string {
	if text == syntheticBestText {
		return "234567"
	}
	return ""
}

func enableBestForTest(t *testing.T, b *broker) {
	t.Helper()
	if err := b.configureProvider(bestInvestProvider, []string{"ExactBestSender"}, syntheticBestCode); err != nil {
		t.Fatal(err)
	}
}

func armProviderTest(t *testing.T, b *broker, provider string) lease {
	t.Helper()
	w := request(b, "POST", "/v1/"+provider+"/arm", "{}")
	if w.Code != 201 {
		t.Fatalf("provider arm status %d", w.Code)
	}
	var result lease
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestBestInvestUnavailableWithoutSenderAndVerifiedTemplate(t *testing.T) {
	b, _ := newTestBroker(t)
	if request(b, "POST", "/v1/best-invest/arm", "{}").Code != 503 {
		t.Fatal("unconfigured provider accepted")
	}
	if err := b.configureProvider(bestInvestProvider, []string{"ExactBestSender"}, nil); err != nil {
		t.Fatal(err)
	}
	if request(b, "POST", "/v1/best-invest/arm", "{}").Code != 503 {
		t.Fatal("sender-only configuration enabled an unverified template")
	}
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 201 {
		t.Fatal("disabled Best Invest affected Clal")
	}
	if request(b, "POST", "/v1/unknown/arm", "{}").Code != 404 {
		t.Fatal("unknown provider accepted")
	}
}

func TestBestInvestProductionMatcherRequiresItsExactSender(t *testing.T) {
	b, now := newTestBroker(t)
	if err := b.configureProvider(bestInvestProvider, []string{"ExactBestSender"}, bestInvestCode); err != nil {
		t.Fatal(err)
	}
	l := armProviderTest(t, b, bestInvestProvider)
	provider, matcher, ok := b.candidateRule()
	if !ok || provider != bestInvestProvider || matcher(textCode) != "" {
		t.Fatal("Best Invest did not select its production matcher")
	}
	code := matcher(bestInvestText)
	*now = now.Add(time.Second)
	b.accept(bestInvestProvider, "wrong-sender", "ExactClalSender", code, *now)
	b.accept(clalProvider, "wrong-provider", "ExactBestSender", code, *now)
	if request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}").Code != 202 {
		t.Fatal("wrong sender or provider delivered a code")
	}
	b.accept(bestInvestProvider, "correct-sender", "ExactBestSender", code, *now)
	response := request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}")
	var result map[string]string
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result["code"] != "123456" {
		t.Fatal("verified template and sender did not deliver the expected code")
	}
}

func TestProviderHealthRequiresSenderAndMatcher(t *testing.T) {
	b, _ := newTestBroker(t)
	if request(b, "GET", "/healthz", "").Code != 200 || request(b, "GET", "/v1/clal/healthz", "").Code != 200 {
		t.Fatal("configured Clal receiver health unavailable")
	}
	if request(b, "GET", "/v1/best-invest/healthz", "").Code != 503 {
		t.Fatal("shared liveness enabled an unconfigured provider")
	}
	if err := b.configureProvider(bestInvestProvider, []string{"ExactBestSender"}, nil); err != nil {
		t.Fatal(err)
	}
	if request(b, "GET", "/v1/best-invest/healthz", "").Code != 503 {
		t.Fatal("sender-only provider health became available")
	}
	if request(b, "GET", "/v1/unknown/healthz", "").Code != 404 {
		t.Fatal("unknown provider health accepted")
	}
}

func TestProviderHealthHasNoLeaseOrPhoneSideEffects(t *testing.T) {
	b, _ := newTestBroker(t)
	enableBestForTest(t, b)
	armProviderTest(t, b, bestInvestProvider)
	before := *b.request
	b.verifyReady = func(context.Context) bool {
		t.Fatal("health contacted the phone")
		return false
	}
	b.persist = func(string, any) error {
		t.Fatal("health persisted private state")
		return nil
	}
	for _, provider := range []string{clalProvider, bestInvestProvider} {
		response := request(b, "GET", "/v1/"+provider+"/healthz", "")
		var result map[string]any
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result) != 2 || result["online"] != true || result["state"] != "ready" {
			t.Fatal("provider health did not report shared readiness")
		}
		if b.request == nil || *b.request != before {
			t.Fatal("health changed the active provider lease")
		}
	}
	b.setHealth(false, "phone_unavailable")
	response := request(b, "GET", "/v1/best-invest/healthz", "")
	var result map[string]any
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result["online"] != false || result["state"] != "phone_unavailable" {
		t.Fatal("provider health did not report lost phone connectivity")
	}
	if b.request != nil || len(b.consumed) != 0 {
		t.Fatal("health recreated a lease or consumed a message")
	}
}

func TestProviderSenderConfigurationFailsClosed(t *testing.T) {
	for _, senders := range [][]string{nil, {}, {""}, {" ExactBestSender"}, {strings.Repeat("a", 101)}} {
		b, _ := newTestBroker(t)
		if b.configureProvider(bestInvestProvider, senders, syntheticBestCode) == nil {
			t.Fatal("invalid exact sender configuration accepted")
		}
		if request(b, "POST", "/v1/best-invest/arm", "{}").Code != 503 {
			t.Fatal("failed configuration became available")
		}
	}
}

func TestSingleLeaseAndProviderOwnedWaitCancelAndMatching(t *testing.T) {
	b, now := newTestBroker(t)
	enableBestForTest(t, b)
	l := armProviderTest(t, b, bestInvestProvider)
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 409 {
		t.Fatal("parallel provider lease accepted")
	}
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 410 {
		t.Fatal("other provider could wait on this lease")
	}
	if request(b, "DELETE", "/v1/clal/"+l.ID, "").Code != 204 || b.request == nil {
		t.Fatal("other provider cancelled this lease")
	}
	*now = now.Add(time.Second)
	b.accept(clalProvider, "shared-id", "ExactClalSender", "123456", *now)
	b.accept(bestInvestProvider, "wrong-sender", "ExactClalSender", "234567", *now)
	if b.eligible(clalProvider, "candidate", *now) {
		t.Fatal("other provider could resolve candidate metadata")
	}
	if request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}").Code != 202 {
		t.Fatal("wrong provider or sender supplied a code")
	}
	// The wrong-provider observation must not poison current-provider deduplication.
	b.accept(bestInvestProvider, "shared-id", "ExactBestSender", "234567", *now)
	w := request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}")
	if w.Code != 200 {
		t.Fatalf("owning provider wait status %d", w.Code)
	}
	var response map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if response["code"] != "234567" {
		t.Fatal("wrong provider code delivered")
	}
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 410 {
		t.Fatal("other provider accessed delivered code")
	}
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 409 {
		t.Fatal("delivery prematurely released global lease")
	}
	request(b, "DELETE", "/v1/best-invest/"+l.ID, "")
	clal := armProviderTest(t, b, clalProvider)
	b.accept(clalProvider, "shared-id", "ExactClalSender", "123456", *now)
	if request(b, "POST", "/v1/clal/"+clal.ID+"/wait", "{}").Code != 202 {
		t.Fatal("consumed source message reused across providers")
	}
}

func TestCandidateMatcherBelongsToCurrentProvider(t *testing.T) {
	b, _ := newTestBroker(t)
	enableBestForTest(t, b)
	if _, _, ok := b.candidateRule(); ok {
		t.Fatal("candidate matching permitted without a lease")
	}
	l := armProviderTest(t, b, bestInvestProvider)
	provider, matcher, ok := b.candidateRule()
	if !ok || provider != bestInvestProvider || matcher(syntheticBestText) != "234567" || matcher(textCode) != "" {
		t.Fatal("Best Invest lease did not use its exact test matcher")
	}
	request(b, "DELETE", "/v1/best-invest/"+l.ID, "")
	armProviderTest(t, b, clalProvider)
	provider, matcher, ok = b.candidateRule()
	if !ok || provider != clalProvider || matcher(textCode) != "123456" || matcher(syntheticBestText) != "" {
		t.Fatal("Clal lease used another provider matcher")
	}
}

func TestBestInvestSharesAgeAmbiguityAndDisconnectSafeguards(t *testing.T) {
	b, now := newTestBroker(t)
	enableBestForTest(t, b)
	l := armProviderTest(t, b, bestInvestProvider)
	b.accept(bestInvestProvider, "old-best", "ExactBestSender", "234567", now.Add(-time.Second))
	b.accept(bestInvestProvider, "future-best", "ExactBestSender", "234567", now.Add(time.Minute))
	if request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}").Code != 202 {
		t.Fatal("old or future Best Invest message accepted")
	}
	*now = now.Add(time.Second)
	b.accept(bestInvestProvider, "first-best", "ExactBestSender", "234567", *now)
	b.accept(bestInvestProvider, "second-best", "ExactBestSender", "234567", *now)
	if request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}").Code != 409 {
		t.Fatal("ambiguous Best Invest messages accepted")
	}
	b.setHealth(false, "disconnected")
	b.setHealth(true, "ready")
	if request(b, "POST", "/v1/best-invest/"+l.ID+"/wait", "{}").Code != 410 {
		t.Fatal("Best Invest lease survived disconnect")
	}
}
