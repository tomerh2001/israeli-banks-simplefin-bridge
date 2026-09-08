package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"go.mau.fi/mautrix-gmessages/pkg/libgm"
)

var errPrivateState = errors.New("private state unavailable")

// All credential/session files remain outside the repository, with no symlinks.
func readPrivateJSON(name string, target any) error {
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 2<<20 {
		return errPrivateState
	}
	file, err := os.Open(name)
	if err != nil {
		return errPrivateState
	}
	defer file.Close()
	dec := json.NewDecoder(io.LimitReader(file, 2<<20))
	if dec.Decode(target) != nil {
		return errPrivateState
	}
	var extra any
	if !errors.Is(dec.Decode(&extra), io.EOF) {
		return errPrivateState
	}
	return nil
}

func writePrivateJSON(name string, value any) error {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return errPrivateState
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return errPrivateState
	}
	file, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return errPrivateState
	}
	nameTmp := file.Name()
	defer os.Remove(nameTmp)
	if file.Chmod(0600) != nil {
		file.Close()
		return errPrivateState
	}
	if json.NewEncoder(file).Encode(value) != nil || file.Sync() != nil {
		file.Close()
		return errPrivateState
	}
	if file.Close() != nil || os.Rename(nameTmp, name) != nil {
		return errPrivateState
	}
	parent, err := os.Open(dir)
	if err != nil {
		return errPrivateState
	}
	defer parent.Close()
	if parent.Sync() != nil {
		return errPrivateState
	}
	return nil
}

// The OS releases flock on crashes; a second receiver/pair process cannot share keys.
func lockSession(name string) (*os.File, error) {
	dir := filepath.Dir(name)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, errPrivateState
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errPrivateState
	}
	fd, err := syscall.Open(name+".lock", syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, errPrivateState
	}
	file := os.NewFile(uintptr(fd), "session-lock")
	if syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		file.Close()
		return nil, errors.New("session busy")
	}
	return file, nil
}

type sessionSaver struct {
	mu   sync.Mutex
	path string
	auth *libgm.AuthData
}

func (s *sessionSaver) save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// libgm rotates Google cookies while receiving responses.
	s.auth.CookiesLock.RLock()
	defer s.auth.CookiesLock.RUnlock()
	return writePrivateJSON(s.path, s.auth)
}
