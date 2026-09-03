package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
	contracts "convenewire.dev/contracts/generated/go"
)

type State string

const (
	StatePreparing      State = "preparing"
	StateAccepted       State = "accepted"
	StateWorking        State = "working"
	StateInputRequired  State = "input_required"
	StateCompleted      State = "completed"
	StateFailed         State = "failed"
	StateCanceled       State = "canceled"
	StateOutcomeUnknown State = "outcome_unknown"
)

const incompatibleTraceQuarantineDirectory = "quarantine-incompatible-trace"
const cancellationTombstoneDirectory = "cancellation-tombstones"

var (
	runIDPattern   = regexp.MustCompile(`^run_[A-Za-z0-9_-]{8,128}$`)
	traceIDPattern = regexp.MustCompile(`^trace_[A-Za-z0-9_-]{8,128}$`)
	agentIDPattern = regexp.MustCompile(`^agent_[A-Za-z0-9_-]{8,128}$`)
)

func isContractRunID(value string) bool {
	return runIDPattern.MatchString(value)
}

func isContractTraceID(value string) bool {
	return traceIDPattern.MatchString(value)
}

type Record struct {
	RunID          string                        `json:"runId"`
	IdempotencyKey string                        `json:"idempotencyKey"`
	PayloadHash    string                        `json:"payloadHash"`
	Request        contracts.RunRequestedPayload `json:"request"`
	State          State                         `json:"state"`
	LastSequence   int64                         `json:"lastSequence"`
	AcceptedAt     time.Time                     `json:"acceptedAt"`
	UpdatedAt      time.Time                     `json:"updatedAt"`
	Events         []json.RawMessage             `json:"events,omitempty"`
}

type CancellationTombstone struct {
	RunID                   string    `json:"runId"`
	TraceID                 string    `json:"traceId"`
	AgentID                 string    `json:"agentId"`
	MessageID               string    `json:"messageId"`
	Reason                  string    `json:"reason"`
	TerminalStatusMessageID string    `json:"terminalStatusMessageId"`
	CreatedAt               time.Time `json:"createdAt"`
}

func (i *Inbox) AppendEvent(
	runID string,
	state State,
	sequence int64,
	value any,
	now time.Time,
) (Record, error) {
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
	if sequence != record.LastSequence+1 {
		return Record{}, fmt.Errorf("Run event sequence gap: %d", sequence)
	}
	source, err := json.Marshal(value)
	if err != nil {
		return Record{}, err
	}
	record.State = state
	record.LastSequence = sequence
	record.UpdatedAt = now.UTC()
	record.Events = append(record.Events, json.RawMessage(source))
	if err := replace(path, record); err != nil {
		return Record{}, err
	}
	return record, nil
}

func (i *Inbox) AppendSupplementalEvidence(
	runID string,
	value contracts.DiscussionSupplementalEvidenceMessage,
	now time.Time,
) (Record, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	path := i.path(runID)
	record, err := i.load(path)
	if err != nil {
		return Record{}, err
	}
	offer := record.Request.DiscussionSupplementalEvidence
	if offer == nil || record.State != StateCompleted ||
		value.Type != contracts.DiscussionSupplementalEvidence ||
		value.Payload.OperationID != offer.OperationID ||
		value.Payload.DiscussionID != offer.DiscussionID ||
		value.Payload.WaveID != offer.WaveID ||
		value.Payload.TurnID != offer.TurnID ||
		value.Payload.RunID != record.RunID ||
		value.Payload.TraceID != record.Request.TraceID ||
		value.Payload.AgentID != record.Request.TargetAgentID ||
		value.Payload.SourceReplySequence < 1 {
		return Record{}, fmt.Errorf("supplemental evidence does not match its frozen offer")
	}
	foundReply := false
	for _, source := range record.Events {
		var envelope struct {
			Type    string `json:"type"`
			Payload struct {
				OperationID string `json:"operationId"`
				Sequence    int64  `json:"sequence"`
			} `json:"payload"`
		}
		if json.Unmarshal(source, &envelope) != nil {
			continue
		}
		if envelope.Type == string(contracts.RunReply) &&
			envelope.Payload.Sequence == value.Payload.SourceReplySequence {
			foundReply = true
		}
		if envelope.Type == string(contracts.DiscussionSupplementalEvidence) &&
			envelope.Payload.OperationID == value.Payload.OperationID {
			var existing contracts.DiscussionSupplementalEvidenceMessage
			if json.Unmarshal(source, &existing) != nil || existing.Payload != value.Payload {
				return Record{}, fmt.Errorf("supplemental evidence operation identity was reused")
			}
			return record, nil
		}
	}
	if !foundReply {
		return Record{}, fmt.Errorf("supplemental evidence reply was not persisted")
	}
	source, err := json.Marshal(value)
	if err != nil {
		return Record{}, err
	}
	record.UpdatedAt = now.UTC()
	record.Events = append(record.Events, json.RawMessage(source))
	if err := replace(path, record); err != nil {
		return Record{}, err
	}
	return record, nil
}

func (i *Inbox) List() ([]Record, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	entries, err := os.ReadDir(i.directory)
	if err != nil {
		return nil, err
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("inbox contains a symbolic link: %s", entry.Name())
		}
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, fmt.Errorf("inspect inbox record: %w", err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("inbox record is not a regular file: %s", entry.Name())
		}
		record, err := i.load(filepath.Join(i.directory, entry.Name()))
		if err != nil {
			return nil, err
		}
		if !isContractRunID(record.RunID) || entry.Name() != record.RunID+".json" {
			return nil, fmt.Errorf("inbox filename does not match Run identity: %s", entry.Name())
		}
		records = append(records, record)
	}
	return records, nil
}

type Inbox struct {
	directory string
	mu        sync.Mutex
}

func Open(directory string) (*Inbox, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create inbox: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, fmt.Errorf("inspect inbox: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmt.Errorf("inbox path must be a directory, not a symbolic link")
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, fmt.Errorf("protect inbox: %w", err)
	}
	return &Inbox{directory: directory}, nil
}

func (i *Inbox) Accept(request contracts.RunRequestedPayload, now time.Time) (Record, bool, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !isContractRunID(request.RunID) {
		return Record{}, false, fmt.Errorf("invalid Run ID")
	}
	if !isContractTraceID(request.TraceID) {
		return Record{}, false, fmt.Errorf("invalid Run trace ID")
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

// QuarantineIncompatibleTrace atomically removes a terminal record with
// incompatible trace metadata from the active inbox without deleting it. The
// dedicated owner-only directory remains available for local audit and is
// ignored by List.
func (i *Inbox) QuarantineIncompatibleTrace(runID string) (string, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !isContractRunID(runID) {
		return "", fmt.Errorf("invalid Run ID")
	}
	source := i.path(runID)
	quarantineDirectory := filepath.Join(i.directory, incompatibleTraceQuarantineDirectory)
	if err := os.MkdirAll(quarantineDirectory, 0o700); err != nil {
		return "", fmt.Errorf("create incompatible trace quarantine: %w", err)
	}
	if err := os.Chmod(quarantineDirectory, 0o700); err != nil {
		return "", fmt.Errorf("protect incompatible trace quarantine: %w", err)
	}
	if err := os.Chmod(source, 0o600); err != nil {
		return "", fmt.Errorf("protect incompatible trace inbox record: %w", err)
	}
	name := filepath.Base(source)
	for suffix := 0; ; suffix++ {
		destinationName := name
		if suffix > 0 {
			destinationName = fmt.Sprintf(
				"%s-duplicate-%d.json",
				strings.TrimSuffix(name, filepath.Ext(name)),
				suffix,
			)
		}
		destination := filepath.Join(quarantineDirectory, destinationName)
		if _, err := os.Lstat(destination); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return "", fmt.Errorf("inspect incompatible trace quarantine target: %w", err)
		}
		if err := os.Rename(source, destination); err != nil {
			return "", fmt.Errorf("quarantine incompatible trace inbox record: %w", err)
		}
		if err := durablefs.SyncDirectory(quarantineDirectory); err != nil {
			return "", fmt.Errorf("sync incompatible trace quarantine: %w", err)
		}
		if err := durablefs.SyncDirectory(i.directory); err != nil {
			return "", fmt.Errorf("sync active inbox after quarantine: %w", err)
		}
		return destination, nil
	}
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

func (i *Inbox) TransitionLocalState(
	runID string,
	expected State,
	next State,
	now time.Time,
) (Record, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	path := i.path(runID)
	record, err := i.load(path)
	if err != nil {
		return Record{}, err
	}
	if record.State != expected {
		return record, fmt.Errorf(
			"Run local state changed: %s, expected %s",
			record.State,
			expected,
		)
	}
	record.State = next
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

// RecordCancellation durably fences Runtime admission before a matching
// run.requested frame is handled. Repeated delivery must preserve the exact
// first cancellation identity.
func (i *Inbox) RecordCancellation(
	requested contracts.RunCancelRequestedMessage,
	now time.Time,
) (CancellationTombstone, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	payload := requested.Payload
	if requested.ProtocolVersion != "1.0" ||
		requested.Type != contracts.RunCancelRequested ||
		!isContractRunID(payload.RunID) ||
		!isContractTraceID(payload.TraceID) ||
		!agentIDPattern.MatchString(payload.AgentID) {
		return CancellationTombstone{}, fmt.Errorf("invalid Run cancellation identity")
	}
	if record, err := i.load(i.path(payload.RunID)); err == nil {
		if record.Request.TraceID != payload.TraceID ||
			record.Request.TargetAgentID != payload.AgentID {
			return CancellationTombstone{}, fmt.Errorf("Run cancellation identity mismatch")
		}
	} else if !os.IsNotExist(err) {
		return CancellationTombstone{}, err
	}
	directory, err := i.ensureCancellationTombstoneDirectory()
	if err != nil {
		return CancellationTombstone{}, err
	}
	path := filepath.Join(directory, payload.RunID+".json")
	if existing, err := loadCancellationTombstone(path); err == nil {
		if existing.RunID != payload.RunID ||
			existing.TraceID != payload.TraceID ||
			existing.AgentID != payload.AgentID ||
			existing.MessageID != requested.MessageID ||
			existing.Reason != payload.Reason {
			return CancellationTombstone{}, fmt.Errorf("Run cancellation tombstone mismatch")
		}
		return existing, nil
	} else if !os.IsNotExist(err) {
		return CancellationTombstone{}, err
	}
	tombstone := CancellationTombstone{
		RunID: payload.RunID, TraceID: payload.TraceID,
		AgentID: payload.AgentID, MessageID: requested.MessageID,
		Reason: payload.Reason, TerminalStatusMessageID: runtimeMessageID(),
		CreatedAt: now.UTC(),
	}
	if err := writeNew(path, tombstone); err != nil {
		return CancellationTombstone{}, err
	}
	return tombstone, nil
}

func (i *Inbox) HasCancellation(
	request contracts.RunRequestedPayload,
) (bool, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !isContractRunID(request.RunID) {
		return false, fmt.Errorf("invalid Run ID")
	}
	tombstone, err := loadCancellationTombstone(i.cancellationTombstonePath(request.RunID))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if tombstone.RunID != request.RunID ||
		tombstone.TraceID != request.TraceID ||
		tombstone.AgentID != request.TargetAgentID {
		return false, fmt.Errorf("Run cancellation tombstone identity mismatch")
	}
	return true, nil
}

func (i *Inbox) ClearCancellation(runID string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if !isContractRunID(runID) {
		return fmt.Errorf("invalid Run ID")
	}
	path := i.cancellationTombstonePath(runID)
	if err := os.Remove(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return durablefs.SyncParent(path)
}

func (i *Inbox) cancellationTombstonePath(runID string) string {
	return filepath.Join(i.directory, cancellationTombstoneDirectory, runID+".json")
}

func (i *Inbox) ensureCancellationTombstoneDirectory() (string, error) {
	directory := filepath.Join(i.directory, cancellationTombstoneDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", fmt.Errorf("create cancellation tombstone directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return "", fmt.Errorf("protect cancellation tombstone directory: %w", err)
	}
	return directory, nil
}

func loadCancellationTombstone(path string) (CancellationTombstone, error) {
	source, err := os.ReadFile(path)
	if err != nil {
		return CancellationTombstone{}, err
	}
	var tombstone CancellationTombstone
	if err := json.Unmarshal(source, &tombstone); err != nil {
		return CancellationTombstone{}, fmt.Errorf("decode cancellation tombstone: %w", err)
	}
	return tombstone, nil
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

func writeNew(path string, value any) error {
	source, err := json.MarshalIndent(value, "", "  ")
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
	if err := file.Close(); err != nil {
		return err
	}
	return durablefs.SyncParent(path)
}

func replace(path string, value any) error {
	source, err := json.MarshalIndent(value, "", "  ")
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
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return durablefs.SyncParent(path)
}
