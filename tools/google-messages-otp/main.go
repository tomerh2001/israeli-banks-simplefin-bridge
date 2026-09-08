// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

func isMissing(name string) bool { _, err := os.Lstat(name); return errors.Is(err, os.ErrNotExist) }
func emit(state string)          { _ = json.NewEncoder(os.Stdout).Encode(map[string]string{"state": state}) }

func main() {
	if err := run(os.Args[1:]); err != nil {
		// Library errors may contain account IDs, cookies, response bodies or messages.
		// Never format/unwrap them into logs or command output.
		emit("failed")
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("command required")
	}
	flags := flag.NewFlagSet("google-messages-otp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	sessionPath := flags.String("session-file", "", "private persistent libgm session")
	cookiesPath := flags.String("cookies-file", "", "private Google cookie JSON; pairing only")
	expectedAccount := flags.String("expected-account", "", "account to verify before pairing")
	socketPath := flags.String("socket", "", "private Unix socket; serving only")
	sendersPath := flags.String("senders-file", "", "private JSON array of exact Clal sender addresses")
	if flags.Parse(args[1:]) != nil || flags.NArg() != 0 {
		return errors.New("invalid arguments")
	}
	if args[0] == "health" {
		if *socketPath == "" {
			return errors.New("socket required")
		}
		return checkHealth(*socketPath)
	}
	if *sessionPath == "" {
		return errors.New("session required")
	}
	if args[0] != "pair" && args[0] != "serve" {
		return errors.New("invalid command")
	}
	lock, err := lockSession(*sessionPath)
	if err != nil {
		return err
	}
	defer lock.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if args[0] == "pair" {
		if *cookiesPath == "" || *expectedAccount == "" || !isMissing(*sessionPath) {
			return errors.New("invalid pairing state")
		}
		return pair(ctx, *cookiesPath, *sessionPath, *expectedAccount)
	}
	if *socketPath == "" || *sendersPath == "" || *cookiesPath != "" {
		return errors.New("invalid receiver configuration")
	}
	return serveReceiver(ctx, *sessionPath, *socketPath, *sendersPath)
}

func checkHealth(socketPath string) error {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second}
	response, err := client.Get("http://localhost/healthz")
	if err != nil {
		return errors.New("receiver unavailable")
	}
	defer response.Body.Close()
	var health struct {
		Online bool   `json:"online"`
		State  string `json:"state"`
	}
	if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&health) != nil || !health.Online || health.State != "ready" {
		return errors.New("receiver not ready")
	}
	emit("ready")
	return nil
}

func pair(ctx context.Context, cookiesPath, sessionPath, expectedAccount string) error {
	var cookies map[string]string
	if err := readPrivateJSON(cookiesPath, &cookies); err != nil {
		return err
	}
	for _, name := range []string{"SID", "HSID", "SSID", "OSID", "APISID", "SAPISID"} {
		if cookies[name] == "" {
			return errors.New("missing Google cookie")
		}
	}
	auth := libgm.NewAuthData()
	auth.SetCookies(cookies)
	cli := libgm.NewClient(auth, nil, zerolog.Nop())
	defer cli.Disconnect()
	pairCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if err := cli.FetchConfig(pairCtx); err != nil {
		return err
	}
	if !strings.EqualFold(cli.Config.GetDeviceInfo().GetEmail(), expectedAccount) {
		return errors.New("wrong Google account")
	}
	emoji, state, err := cli.StartGaiaPairing(pairCtx)
	if err != nil {
		return err
	}
	// Pairing emoji is the only user-facing authentication material.
	if err = json.NewEncoder(os.Stdout).Encode(map[string]string{"state": "pairing", "emoji": emoji}); err != nil {
		return err
	}
	if _, err = cli.FinishGaiaPairing(pairCtx, state); err != nil {
		return err
	}
	saver := sessionSaver{path: sessionPath, auth: auth}
	if err = saver.save(); err != nil {
		return err
	}
	emit("paired")
	return nil
}

type receiver struct {
	client    *libgm.Client
	broker    *broker
	saver     *sessionSaver
	ctx       context.Context
	lookup    chan struct{}
	mu        sync.Mutex
	active    bool
	listening bool
	phone     bool
	syncing   bool
	fatal     bool
}

func (r *receiver) status() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fatal {
		r.broker.setHealth(false, "reauth_required")
		return
	}
	if !r.listening {
		r.broker.setHealth(false, "disconnected")
		return
	}
	if !r.active {
		r.broker.setHealth(false, "inactive")
		return
	}
	if !r.phone {
		r.broker.setHealth(false, "phone_unavailable")
		return
	}
	if r.syncing {
		r.broker.setHealth(false, "phone_syncing")
		return
	}
	r.broker.setHealth(true, "ready")
}

func (r *receiver) handle(raw any) {
	switch evt := raw.(type) {
	case *events.AuthTokenRefreshed:
		if err := r.saver.save(); err != nil {
			r.broker.setHealth(false, "state_write_failed")
		}
	case *events.ListenFatalError, *events.GaiaLoggedOut, *gmproto.RevokePairData:
		r.mu.Lock()
		r.fatal = true
		r.mu.Unlock()
		r.status()
	case *events.ListenTemporaryError:
		r.mu.Lock()
		r.listening = false
		r.mu.Unlock()
		r.status()
	case *events.ListenRecovered:
		r.mu.Lock()
		r.listening = true
		r.mu.Unlock()
		r.status()
	case *events.PhoneNotResponding, *events.PingFailed:
		r.mu.Lock()
		r.phone = false
		r.mu.Unlock()
		r.status()
	case *events.PhoneRespondingAgain:
		r.mu.Lock()
		r.phone = true
		r.mu.Unlock()
		r.status()
	case *gmproto.UserAlertEvent:
		r.mu.Lock()
		switch evt.GetAlertType() {
		case gmproto.AlertType_BROWSER_ACTIVE:
			r.active = true
			r.listening = true
			r.phone = true
		case gmproto.AlertType_BROWSER_INACTIVE, gmproto.AlertType_BROWSER_INACTIVE_FROM_INACTIVITY, gmproto.AlertType_BROWSER_INACTIVE_FROM_TIMEOUT:
			r.active = false
		case gmproto.AlertType_MOBILE_DATABASE_SYNCING, gmproto.AlertType_MOBILE_DATABASE_SYNC_STARTED, gmproto.AlertType_BR_MESSAGE_RESTORE_STARTED:
			r.syncing = true
		case gmproto.AlertType_MOBILE_DATABASE_SYNC_COMPLETE, gmproto.AlertType_BR_MESSAGE_RESTORE_COMPLETED:
			r.syncing = false
		}
		r.mu.Unlock()
		r.status()
	case *libgm.WrappedMessage:
		r.message(evt)
	}
}

func candidate(evt *libgm.WrappedMessage) (string, time.Time, bool) {
	if evt == nil || evt.Message == nil || evt.IsOld || evt.GetTimestamp() <= 0 || evt.GetType() != 1 {
		return "", time.Time{}, false
	}
	switch evt.GetMessageStatus().GetStatus() {
	case gmproto.MessageStatusType_INCOMING_COMPLETE, gmproto.MessageStatusType_INCOMING_DELIVERED, gmproto.MessageStatusType_INCOMING_DISPLAYED:
	default:
		return "", time.Time{}, false
	}
	var text strings.Builder
	for _, info := range evt.GetMessageInfo() {
		if info.GetMediaContent() != nil {
			return "", time.Time{}, false
		}
		text.WriteString(info.GetMessageContent().GetContent())
		if text.Len() > 4096 {
			return "", time.Time{}, false
		}
	}
	code := clalCode(text.String())
	return code, time.UnixMicro(evt.GetTimestamp()), code != "" && evt.GetMessageID() != ""
}

func (r *receiver) message(evt *libgm.WrappedMessage) {
	code, at, ok := candidate(evt)
	if !ok {
		return
	}
	// A sender directly supplied by the event needs no conversation lookup.
	if sender := evt.GetSenderParticipant(); sender != nil && sender.GetID().GetNumber() != "" {
		if !sender.GetIsMe() && sender.GetID().GetParticipantID() == evt.GetParticipantID() {
			r.broker.accept(evt.GetMessageID(), sender.GetID().GetNumber(), code, at)
		}
		return
	}
	// Resolve only a current exact-template candidate, not arbitrary inbox data.
	if !r.broker.eligible(evt.GetMessageID(), at) {
		return
	}
	select {
	case r.lookup <- struct{}{}:
	default:
		r.broker.setHealth(false, "candidate_overflow")
		return
	}
	id, conversationID, participantID := evt.GetMessageID(), evt.GetConversationID(), evt.GetParticipantID()
	go func() {
		defer func() { <-r.lookup }()
		ctx, cancel := context.WithTimeout(r.ctx, 10*time.Second)
		defer cancel()
		conversation, err := r.client.GetConversation(ctx, conversationID)
		if err != nil || conversation == nil || conversation.GetIsGroupChat() {
			return
		}
		for _, sender := range conversation.GetParticipants() {
			if sender.GetID().GetParticipantID() == participantID && !sender.GetIsMe() {
				r.broker.accept(id, sender.GetID().GetNumber(), code, at)
				return
			}
		}
	}()
}

func serveReceiver(ctx context.Context, sessionPath, socketPath, sendersPath string) error {
	var auth libgm.AuthData
	if err := readPrivateJSON(sessionPath, &auth); err != nil {
		return err
	}
	if auth.Browser == nil || auth.Mobile == nil || auth.RequestCrypto == nil || auth.RefreshKey == nil || !auth.IsGoogleAccount() || !auth.HasCookies() {
		return errors.New("invalid paired session")
	}
	var senders []string
	if err := readPrivateJSON(sendersPath, &senders); err != nil {
		return err
	}
	b, err := newBroker(senders, sessionPath+".consumed.json")
	if err != nil {
		return err
	}
	cli := libgm.NewClient(&auth, nil, zerolog.Nop())
	cli.SetPingInterval(20 * time.Minute)
	cli.SetDataReceiveCheckInterval(15 * time.Minute)
	b.verifyReady = func(ctx context.Context) bool {
		result, err := cli.IsBugleDefault(ctx)
		return err == nil && result.GetSuccess()
	}
	rec := &receiver{client: cli, broker: b, saver: &sessionSaver{path: sessionPath, auth: &auth}, ctx: ctx, lookup: make(chan struct{}, 4), listening: true}
	cli.SetEventHandler(rec.handle)
	if err = cli.Connect(); err != nil {
		return err
	}
	defer func() { cli.Disconnect(); _ = rec.saver.save() }()
	listener, err := privateSocket(socketPath)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	server := &http.Server{Handler: b, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 25 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	emit("receiver_started")
	select {
	case err = <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		b.setHealth(false, "stopping")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}
	return nil
}

func privateSocket(name string) (net.Listener, error) {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errPrivateState
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errPrivateState
	}
	if info, err := os.Lstat(name); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("socket path occupied")
		}
		// Session flock already excludes another process using this pairing. Still
		// refuse to unlink any socket which currently accepts connections.
		conn, dialErr := net.DialTimeout("unix", name, 200*time.Millisecond)
		if dialErr == nil {
			conn.Close()
			return nil, errors.New("socket busy")
		}
		if err = os.Remove(name); err != nil {
			return nil, errPrivateState
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, errPrivateState
	}
	listener, err := net.Listen("unix", name)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(name, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}
