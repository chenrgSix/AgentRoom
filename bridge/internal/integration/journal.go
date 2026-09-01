package integration

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"convenewire.dev/bridge/internal/durablefs"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

const maxJournalRecordBytes = 2 << 20

type Owner struct {
	ServerURL     string `json:"serverUrl"`
	TeamID        string `json:"teamId"`
	DeviceID      string `json:"deviceId"`
	OwnerMemberID string `json:"ownerMemberId"`
}

type IntentRecord struct {
	Version   int       `json:"version"`
	Admission Admission `json:"admission"`
}

type Journal struct {
	mu     sync.Mutex
	owner  Owner
	root   string
	closed bool
}

func OpenJournal(dataDir string, owner Owner) (*Journal, error) {
	if !validOwner(owner) || !filepath.IsAbs(dataDir) || filepath.Clean(dataDir) != dataDir {
		return nil, ErrInvalid
	}
	info, err := os.Lstat(dataDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, ErrInvalid
	}
	ownerJSON, _ := json.Marshal(owner)
	ownerDigest, _ := executionDigest(ownerJSON)
	root := filepath.Join(dataDir, "integration-journal", ownerDigest)
	for _, directory := range []string{filepath.Dir(root), root} {
		if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		current, err := os.Lstat(directory)
		if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 ||
			(runtime.GOOS != "windows" && current.Mode().Perm()&0o077 != 0) {
			return nil, ErrChanged
		}
		if err := durablefs.SyncParent(directory); err != nil {
			return nil, err
		}
	}
	return &Journal{owner: owner, root: root}, nil
}

func (j *Journal) PutIntent(record IntentRecord) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil || !validIntent(record) {
		return ErrInvalid
	}
	return j.ensure(j.path(record.Admission.Operation.OperationID, "intent"), record)
}

func (j *Journal) Intent(operationID string) (*IntentRecord, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil {
		return nil, err
	}
	var record IntentRecord
	if err := readJournal(j.path(operationID, "intent"), &record); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if !validIntent(record) || record.Admission.Operation.OperationID != operationID {
		return nil, ErrChanged
	}
	return &record, nil
}

func (j *Journal) PutReceipt(receipt execution.RepositoryOperationReceipt) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil || validateReceipt(receipt) != nil || receipt.Kind != execution.Integrate {
		return ErrInvalid
	}
	return j.ensure(j.path(receipt.OperationID, "receipt"), receipt)
}

func (j *Journal) Receipt(operationID string) (*execution.RepositoryOperationReceipt, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if err := j.check(); err != nil {
		return nil, err
	}
	var receipt execution.RepositoryOperationReceipt
	if err := readJournal(j.path(operationID, "receipt"), &receipt); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if receipt.OperationID != operationID || receipt.Kind != execution.Integrate || validateReceipt(receipt) != nil {
		return nil, ErrChanged
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
		return ErrInvalid
	}
	if err := writeExclusive(path, raw); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrExist) {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(existing, raw) {
		return ErrConflict
	}
	return durablefs.SyncParent(path)
}

func (j *Journal) path(operationID, kind string) string {
	if !validOperationID(operationID) {
		return filepath.Join(j.root, "invalid")
	}
	return filepath.Join(j.root, operationID+"."+kind+".json")
}

func (j *Journal) check() error {
	if j == nil || j.closed || !validOwner(j.owner) {
		return ErrInvalid
	}
	info, err := os.Lstat(j.root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return ErrChanged
	}
	return nil
}

func validOwner(owner Owner) bool {
	return owner.ServerURL != "" && owner.TeamID != "" && owner.DeviceID != "" && owner.OwnerMemberID != ""
}

func validIntent(record IntentRecord) bool {
	return record.Version == 1 && validAdmission(record.Admission)
}

func readJournal(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maxJournalRecordBytes {
		return ErrChanged
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrChanged
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrChanged
	}
	return nil
}

func executionDigest(raw []byte) (string, error) { return wire.ExecutionDigest(raw) }
