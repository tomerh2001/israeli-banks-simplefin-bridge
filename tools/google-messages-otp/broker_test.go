package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

const textCode = "קוד האימות לחשבון האישי שלך הוא: 123456\nתודה, כלל ביטוח ופיננסים\n\n@www.clalbit.co.il #123456"

func newTestBroker(t *testing.T) (*broker, *time.Time) {
	t.Helper()
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	b, err := newBroker([]string{"ExactClalSender"}, filepath.Join(dir, "consumed.json"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 8, 10, 0, 0, 0, time.UTC)
	b.now = func() time.Time { return now }
	b.waitDuration = time.Millisecond
	b.setHealth(true, "ready")
	return b, &now
}

func request(b *broker, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	w := httptest.NewRecorder()
	b.ServeHTTP(w, r)
	return w
}
func armTest(t *testing.T, b *broker) lease {
	t.Helper()
	w := request(b, "POST", "/v1/clal/arm", "{}")
	if w.Code != 201 {
		t.Fatalf("arm status %d", w.Code)
	}
	var l lease
	if err := json.Unmarshal(w.Body.Bytes(), &l); err != nil {
		t.Fatal(err)
	}
	return l
}

func TestClalTemplate(t *testing.T) {
	if clalCode(textCode) != "123456" {
		t.Fatal("valid template rejected")
	}
	for _, input := range []string{
		strings.Replace(textCode, "#123456", "#654321", 1),
		strings.Replace(textCode, "www.clalbit.co.il", "www.clalbit.co.il.attacker.test", 1),
		strings.Replace(textCode, "123456", "１２３４５６", -1),
		textCode + "\nextra footer", "123456", "@www.clalbit.co.il #123456",
		textCode + "\n" + textCode,
	} {
		if clalCode(input) != "" {
			t.Fatal("invalid template accepted")
		}
	}
}

func TestLeaseSingleUseAndPersistentDedup(t *testing.T) {
	b, now := newTestBroker(t)
	l := armTest(t, b)
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 409 {
		t.Fatal("parallel arm accepted")
	}
	*now = now.Add(time.Second)
	b.accept("message1", "ExactClalSender", "123456", *now)
	w := request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}")
	if w.Code != 200 {
		t.Fatalf("wait status %d", w.Code)
	}
	var result map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result["code"] != "123456" || result["requestId"] != l.ID {
		t.Fatal("incorrect delivery")
	}
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 410 {
		t.Fatal("code reused")
	}
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 409 {
		t.Fatal("delivered lease was released early")
	}
	data, _ := os.ReadFile(b.consumedPath)
	if strings.Contains(string(data), "123456") || strings.Contains(string(data), "message1") {
		t.Fatal("private message persisted")
	}
	if request(b, "DELETE", "/v1/clal/"+l.ID, "").Code != 204 {
		t.Fatal("cancel failed")
	}
	b2, err := newBroker([]string{"ExactClalSender"}, b.consumedPath)
	if err != nil {
		t.Fatal(err)
	}
	b2.now = b.now
	b2.waitDuration = time.Millisecond
	b2.setHealth(true, "ready")
	l2 := armTest(t, b2)
	*now = now.Add(time.Second)
	b2.accept("message1", "ExactClalSender", "123456", *now)
	if request(b2, "POST", "/v1/clal/"+l2.ID+"/wait", "{}").Code != 202 {
		t.Fatal("persistently consumed ID accepted")
	}
}

func TestRejectStaleWrongSenderFutureAndAmbiguous(t *testing.T) {
	b, now := newTestBroker(t)
	l := armTest(t, b)
	b.accept("wrong", "OtherSender", "123456", now.Add(time.Second))
	b.accept("stale", "ExactClalSender", "123456", now.Add(-time.Second))
	b.accept("future", "ExactClalSender", "123456", now.Add(time.Minute))
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 202 {
		t.Fatal("invalid candidate accepted")
	}
	*now = now.Add(time.Second)
	b.accept("new1", "ExactClalSender", "123456", *now)
	b.accept("new2", "ExactClalSender", "654321", *now)
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 409 {
		t.Fatal("ambiguous candidates accepted")
	}
}

func TestDisconnectAndExpiryInvalidateRequests(t *testing.T) {
	b, now := newTestBroker(t)
	l := armTest(t, b)
	*now = now.Add(181 * time.Second)
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 410 {
		t.Fatal("expired lease accepted")
	}
	l = armTest(t, b)
	b.setHealth(false, "disconnected")
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 503 {
		t.Fatal("offline arm accepted")
	}
	b.setHealth(true, "ready")
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 410 {
		t.Fatal("reconnected lease retained")
	}
}

func TestRequestCannotSelectProviderSenderOrTime(t *testing.T) {
	b, _ := newTestBroker(t)
	for _, body := range []string{`{"sender":"OtherSender"}`, `{"armedAt":"2000-01-01"}`, `null`, `{} {}`, `[]`} {
		if request(b, "POST", "/v1/clal/arm", body).Code != 400 {
			t.Fatal("caller fields accepted")
		}
	}
	if request(b, "POST", "/v1/clal/arm?sender=other", "{}").Code != 400 {
		t.Fatal("query accepted")
	}
}

func TestCandidatesRejectBackfillOutgoingMissingTimestampAndMMS(t *testing.T) {
	m := &libgm.WrappedMessage{Message: &gmproto.Message{
		MessageID: "id", Timestamp: time.Now().UnixMicro(), Type: 1,
		MessageStatus: &gmproto.MessageStatus{Status: gmproto.MessageStatusType_INCOMING_COMPLETE},
		MessageInfo:   []*gmproto.MessageInfo{{Data: &gmproto.MessageInfo_MessageContent{MessageContent: &gmproto.MessageContent{Content: textCode}}}},
	}}
	if _, _, ok := candidate(m); !ok {
		t.Fatal("valid message rejected")
	}
	m.IsOld = true
	if _, _, ok := candidate(m); ok {
		t.Fatal("backfill accepted")
	}
	m.IsOld = false
	m.MessageStatus.Status = gmproto.MessageStatusType_OUTGOING_COMPLETE
	if _, _, ok := candidate(m); ok {
		t.Fatal("outgoing accepted")
	}
	m.MessageStatus.Status = gmproto.MessageStatusType_INCOMING_COMPLETE
	m.Timestamp = 0
	if _, _, ok := candidate(m); ok {
		t.Fatal("missing timestamp accepted")
	}
	m.Timestamp = time.Now().UnixMicro()
	m.Type = 2
	if _, _, ok := candidate(m); ok {
		t.Fatal("MMS accepted")
	}
}

func TestStateFileModeAndSessionExclusion(t *testing.T) {
	dir := t.TempDir()
	_ = os.Chmod(dir, 0700)
	name := filepath.Join(dir, "session.json")
	if err := writePrivateJSON(name, map[string]string{"example": "data"}); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(name)
	if info.Mode().Perm() != 0600 {
		t.Fatal("incorrect mode")
	}
	var decoded map[string]string
	if err := readPrivateJSON(name, &decoded); err != nil {
		t.Fatal(err)
	}
	lock, err := lockSession(name)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if second, err := lockSession(name); err == nil {
		second.Close()
		t.Fatal("concurrent session accepted")
	}
	_ = os.Chmod(name, 0644)
	if readPrivateJSON(name, &decoded) == nil {
		t.Fatal("public session accepted")
	}
}

func TestPersistenceFailureRemainsUnavailableAfterReconnect(t *testing.T) {
	b, now := newTestBroker(t)
	l := armTest(t, b)
	*now = now.Add(time.Second)
	b.accept("new", "ExactClalSender", "123456", *now)
	b.persist = func(string, any) error { return errors.New("disk unavailable") }
	if request(b, "POST", "/v1/clal/"+l.ID+"/wait", "{}").Code != 503 {
		t.Fatal("failed persistence delivered a code")
	}
	b.setHealth(true, "ready")
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 503 {
		t.Fatal("reconnect cleared terminal failure")
	}
	if b.health != "state_write_failed" {
		t.Fatal("terminal failure hidden")
	}
}

func TestArmRequiresFreshPhoneResponse(t *testing.T) {
	b, _ := newTestBroker(t)
	called := false
	b.verifyReady = func(ctx context.Context) bool {
		called = true
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("unbounded readiness request")
		}
		return false
	}
	if request(b, "POST", "/v1/clal/arm", "{}").Code != 503 || !called {
		t.Fatal("offline phone accepted")
	}
}
