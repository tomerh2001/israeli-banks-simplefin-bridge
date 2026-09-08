package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Deliberately synthetic test grammar; it is not an asserted Hachshara SMS template.
const syntheticBestText = "TEST ONLY BEST INVEST OTP: 234567"

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
