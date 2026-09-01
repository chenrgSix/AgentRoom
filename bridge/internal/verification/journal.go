package verification

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"convenewire.dev/bridge/internal/durablefs"
	execution "convenewire.dev/contracts/generated/go/execution"
)

const maxJournalRecordBytes = 2 << 20

type TerminalRecord struct {
	Version    int                                  `json:"version"`
	Operation  execution.RepositoryOperationRequest `json:"operation"`
	Checkpoint execution.RepositoryCheckpoint       `json:"checkpoint"`
	Result     Result                               `json:"result"`
}

type Journal struct {
	mu     sync.Mutex
	owner  Owner
	root   string
	closed bool
}

func OpenJournal(dataDir string, owner Owner) (*Journal, error) {
	if !validOwner(owner) || !filepath.IsAbs(dataDir) || filepath.Clean(dataDir) != dataDir {
		return nil, ErrProfileInvalid
	}
	info, err := os.Lstat(dataDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, ErrProfileInvalid
	}
	ownerJSON, _ := json.Marshal(owner)
	root := filepath.Join(dataDir, "verification-journal", hash(ownerJSON))
	for _, directory := range []string{filepath.Dir(root), root} {
		if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		current, err := os.Lstat(directory)
		if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 ||
			(runtime.GOOS != "windows" && current.Mode().Perm()&0o077 != 0) {
			return nil, ErrProfileChanged
		}
		if err := durablefs.SyncParent(directory); err != nil {
			return nil, err
		}
	}
	return &Journal{owner: owner, root: root}, nil
}

func (j *Journal) PutTerminal(record TerminalRecord) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil || !validTerminalRecord(record) {
		return ErrProfileInvalid
	}
	return j.ensure(j.path(record.Operation.OperationID, "terminal"), record)
}

func (j *Journal) Terminal(operationID string) (*TerminalRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil {
		return nil, err
	}
	var record TerminalRecord
	if err := readJournal(j.path(operationID, "terminal"), &record); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if !validTerminalRecord(record) || record.Operation.OperationID != operationID {
		return nil, ErrProfileChanged
	}
	return &record, nil
}

func (j *Journal) PutReceipt(receipt execution.VerificationReceipt) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil {
		return err
	}
	if err := validateReceipt(receipt); err != nil {
		return err
	}
	return j.ensure(j.path(receipt.OperationID, "receipt"), receipt)
}

func (j *Journal) Receipt(operationID string) (*execution.VerificationReceipt, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil {
		return nil, err
	}
	var receipt execution.VerificationReceipt
	if err := readJournal(j.path(operationID, "receipt"), &receipt); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if receipt.OperationID != operationID || validateReceipt(receipt) != nil {
		return nil, ErrProfileChanged
	}
	return &receipt, nil
}

func (j *Journal) Close() error {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.closed = true
	return nil
}

func (j *Journal) ensure(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) == 0 || len(raw) > maxJournalRecordBytes {
		return ErrProfileInvalid
	}
	if err := writeExclusive(path, raw); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrExist) {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(existing, raw) {
		return ErrProfileConflict
	}
	return durablefs.SyncParent(path)
}

func (j *Journal) path(operationID, kind string) string {
	if !strings.HasPrefix(operationID, "op_") || strings.ContainsAny(operationID, `/\\`) {
		return filepath.Join(j.root, "invalid")
	}
	return filepath.Join(j.root, operationID+"."+kind+".json")
}

func (j *Journal) check() error {
	if j == nil || j.closed || !validOwner(j.owner) {
		return ErrProfileInvalid
	}
	info, err := os.Lstat(j.root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrProfileChanged
	}
	return nil
}

func validTerminalRecord(record TerminalRecord) bool {
	if record.Version != 1 || record.Operation.Action.Kind != execution.Verify ||
		record.Operation.Action.Verify == nil || record.Operation.OperationID == "" ||
		record.Checkpoint.OperationID == "" || len(record.Result.Log) == 0 ||
		record.Result.StartedAt.IsZero() || record.Result.FinishedAt.IsZero() ||
		record.Result.FinishedAt.Before(record.Result.StartedAt) {
		return false
	}
	return validateSigned("repositoryOperation", record.Operation, "requestDigest") == nil
}

func readJournal(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 ||
		info.Size() > maxJournalRecordBytes {
		return ErrProfileChanged
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrProfileChanged
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrProfileChanged
	}
	return nil
}
