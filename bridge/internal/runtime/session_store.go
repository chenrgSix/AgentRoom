package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const runtimeSessionSchemaVersion = 2

type RuntimeSessionKey struct {
	RuntimeKind          string `json:"runtimeKind"`
	RoomID               string `json:"roomId"`
	TaskID               string `json:"taskId"`
	AgentID              string `json:"agentId"`
	WorkspaceFingerprint string `json:"workspaceFingerprint"`
	ConfigFingerprint    string `json:"configFingerprint"`
	SchemaVersion        int    `json:"schemaVersion"`
}

type RuntimeSessionBinding struct {
	RuntimeSessionKey
	SessionID        string    `json:"sessionId"`
	LastRoomSequence int64     `json:"lastRoomSequence"`
	LastRunID        string    `json:"lastRunId,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type RuntimeSessionStore interface {
	Load(RuntimeSessionKey) (RuntimeSessionBinding, bool, error)
	Save(RuntimeSessionBinding) error
	Delete(RuntimeSessionKey) error
}

type FileRuntimeSessionStore struct {
	root string
}

func NewFileRuntimeSessionStore(dataDir string) *FileRuntimeSessionStore {
	return &FileRuntimeSessionStore{root: filepath.Join(dataDir, "runtime-sessions")}
}

func (s *FileRuntimeSessionStore) Load(key RuntimeSessionKey) (RuntimeSessionBinding, bool, error) {
	path, err := s.bindingPath(key)
	if err != nil {
		return RuntimeSessionBinding{}, false, err
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return RuntimeSessionBinding{}, false, nil
	}
	if err != nil {
		return RuntimeSessionBinding{}, false, fmt.Errorf("inspect Runtime session binding: %w", err)
	}
	if !info.Mode().IsRegular() {
		return RuntimeSessionBinding{}, false, fmt.Errorf("Runtime session binding is not a regular file")
	}
	source, err := os.ReadFile(path)
	if err != nil {
		return RuntimeSessionBinding{}, false, fmt.Errorf("read Runtime session binding: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(source)))
	decoder.DisallowUnknownFields()
	var binding RuntimeSessionBinding
	if err := decoder.Decode(&binding); err != nil {
		return RuntimeSessionBinding{}, false, fmt.Errorf("decode Runtime session binding: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return RuntimeSessionBinding{}, false, fmt.Errorf("decode Runtime session binding: trailing data")
	}
	if binding.RuntimeSessionKey != key || strings.TrimSpace(binding.SessionID) == "" ||
		binding.LastRoomSequence < 0 || binding.CreatedAt.IsZero() || binding.UpdatedAt.IsZero() {
		return RuntimeSessionBinding{}, false, fmt.Errorf("Runtime session binding does not match its key")
	}
	return binding, true, nil
}

func (s *FileRuntimeSessionStore) Save(binding RuntimeSessionBinding) error {
	path, err := s.bindingPath(binding.RuntimeSessionKey)
	if err != nil {
		return err
	}
	if strings.TrimSpace(binding.SessionID) == "" {
		return fmt.Errorf("Runtime session id is required")
	}
	if binding.LastRoomSequence < 0 {
		return fmt.Errorf("Runtime session cursor cannot be negative")
	}
	now := time.Now().UTC()
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	if binding.UpdatedAt.IsZero() {
		binding.UpdatedAt = now
	}
	if err := os.MkdirAll(s.root, 0o700); err != nil {
		return fmt.Errorf("create Runtime session directory: %w", err)
	}
	if err := os.Chmod(s.root, 0o700); err != nil {
		return fmt.Errorf("protect Runtime session directory: %w", err)
	}
	source, err := json.MarshalIndent(binding, "", "  ")
	if err != nil {
		return fmt.Errorf("encode Runtime session binding: %w", err)
	}
	temporary, err := os.CreateTemp(s.root, ".session-*")
	if err != nil {
		return fmt.Errorf("create Runtime session binding: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect Runtime session binding: %w", err)
	}
	if _, err := temporary.Write(append(source, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("write Runtime session binding: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync Runtime session binding: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Runtime session binding: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace Runtime session binding: %w", err)
	}
	return nil
}

func (s *FileRuntimeSessionStore) Delete(key RuntimeSessionKey) error {
	path, err := s.bindingPath(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete Runtime session binding: %w", err)
	}
	return nil
}

func (s *FileRuntimeSessionStore) bindingPath(key RuntimeSessionKey) (string, error) {
	if strings.TrimSpace(s.root) == "" {
		return "", fmt.Errorf("Runtime session directory is required")
	}
	if strings.TrimSpace(key.RuntimeKind) == "" || strings.TrimSpace(key.RoomID) == "" ||
		strings.TrimSpace(key.TaskID) == "" || strings.TrimSpace(key.AgentID) == "" ||
		strings.TrimSpace(key.WorkspaceFingerprint) == "" ||
		strings.TrimSpace(key.ConfigFingerprint) == "" ||
		key.SchemaVersion != runtimeSessionSchemaVersion {
		return "", fmt.Errorf("Runtime session key is incomplete")
	}
	source, err := json.Marshal(key)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(source)
	return filepath.Join(s.root, hex.EncodeToString(digest[:])+".json"), nil
}
