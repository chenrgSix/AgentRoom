package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	contracts "agentroom.dev/contracts/generated/go"
)

type State string

const (
	StateAccepted       State = "accepted"
	StateWorking        State = "working"
	StateCompleted      State = "completed"
	StateFailed         State = "failed"
	StateOutcomeUnknown State = "outcome_unknown"
)

type Record struct {
	RunID          string                        `json:"runId"`
	IdempotencyKey string                        `json:"idempotencyKey"`
	PayloadHash    string                        `json:"payloadHash"`
	Request        contracts.RunRequestedPayload `json:"request"`
	State          State                         `json:"state"`
	LastSequence   int64                         `json:"lastSequence"`
	AcceptedAt     time.Time                     `json:"acceptedAt"`
	UpdatedAt      time.Time                     `json:"updatedAt"`
}

type Inbox struct {
	directory string
	mu        sync.Mutex
}

func Open(directory string) (*Inbox, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create inbox: %w", err)
	}
	return &Inbox{directory: directory}, nil
}

func (i *Inbox) Accept(request contracts.RunRequestedPayload, now time.Time) (Record, bool, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !strings.HasPrefix(request.RunID, "run_") || strings.ContainsAny(request.RunID, "/\\") {
		return Record{}, false, fmt.Errorf("invalid Run ID")
	}
	source, err := json.Marshal(request)
	if err != nil {
		return Record{}, false, err
	}
	digest := sha256.Sum256(source)
	payloadHash := hex.EncodeToString(digest[:])
	path := i.path(request.RunID)
	if existing, err := i.load(path); err == nil {
		if existing.IdempotencyKey != request.IdempotencyKey || existing.PayloadHash != payloadHash {
			return Record{}, true, fmt.Errorf("duplicate Run payload mismatch")
		}
		return existing, true, nil
	} else if !os.IsNotExist(err) {
		return Record{}, false, err
	}
	record := Record{
		RunID: request.RunID, IdempotencyKey: request.IdempotencyKey,
		PayloadHash: payloadHash, Request: request, State: StateAccepted,
		LastSequence: 1, AcceptedAt: now.UTC(), UpdatedAt: now.UTC(),
	}
	if err := writeNew(path, record); err != nil {
		return Record{}, false, err
	}
	return record, false, nil
}

func (i *Inbox) Update(runID string, state State, sequence int64, now time.Time) (Record, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	path := i.path(runID)
	record, err := i.load(path)
	if err != nil {
		return Record{}, err
	}
	if sequence <= record.LastSequence {
		return record, nil
	}
	record.State = state
	record.LastSequence = sequence
	record.UpdatedAt = now.UTC()
	if err := replace(path, record); err != nil {
		return Record{}, err
	}
	return record, nil
}

func (i *Inbox) Get(runID string) (Record, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.load(i.path(runID))
}

func (i *Inbox) path(runID string) string {
	return filepath.Join(i.directory, runID+".json")
}

func (i *Inbox) load(path string) (Record, error) {
	source, err := os.ReadFile(path)
	if err != nil {
		return Record{}, err
	}
	var record Record
	if err := json.Unmarshal(source, &record); err != nil {
		return Record{}, fmt.Errorf("decode inbox record: %w", err)
	}
	return record, nil
}

func writeNew(path string, record Record) error {
	source, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(source, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func replace(path string, record Record) error {
	source, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".run-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(source, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
