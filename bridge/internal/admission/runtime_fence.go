package admission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrAdmissionInvalid    = errors.New("local Runtime admission is invalid")
	ErrAdmissionChanged    = errors.New("local Runtime admission state changed")
	ErrAdmissionConflict   = errors.New("local Runtime admission conflicts with immutable state")
	ErrAdmissionNotCurrent = errors.New("local Runtime admission is not current")
	runID                  = regexp.MustCompile(`^run_[A-Za-z0-9_-]{8,128}$`)
	operationID            = regexp.MustCompile(`^op_[A-Za-z0-9_-]{8,128}$`)
	objectID               = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
)

const (
	RuntimeAdmissionClaimed  = "claimed"
	RuntimeAdmissionStarting = "starting"
	RuntimeAdmissionStopped  = "stopped"

	RuntimeOutcomeCompleted     RuntimeOutcome = "completed"
	RuntimeOutcomeFailed        RuntimeOutcome = "failed"
	RuntimeOutcomeCanceled      RuntimeOutcome = "canceled"
	RuntimeOutcomeInputRequired RuntimeOutcome = "input_required"
	RuntimeOutcomeUnknown       RuntimeOutcome = "outcome_unknown"

	maxRuntimeAdmissions = 256
)

// RuntimeOutcome is a closed local process outcome. It is not a Task Result,
// verification receipt or completion decision.
type RuntimeOutcome string

// RuntimeAdmissionSpec is the path-free join between one frozen manifest, one
// exact prepared workspace and one current owner-local Runtime profile.
type RuntimeAdmissionSpec struct {
	RunID                  string `json:"runId"`
	TaskID                 string `json:"taskId"`
	AgentID                string `json:"agentId"`
	DeviceID               string `json:"deviceId"`
	PlanID                 string `json:"planId"`
	PlanRevision           int64  `json:"planRevision"`
	PlanDigest             string `json:"planDigest"`
	ApprovalOperationID    string `json:"approvalOperationId"`
	PlanControlRevision    int64  `json:"planControlRevision"`
	NodeKey                string `json:"nodeKey"`
	DispatchGeneration     int64  `json:"dispatchGeneration"`
	RoomID                 string `json:"roomId"`
	TaskRevision           int64  `json:"taskRevision"`
	DefinitionRevision     int64  `json:"definitionRevision"`
	CriteriaRevision       int64  `json:"criteriaRevision"`
	ManifestDigest         string `json:"manifestDigest"`
	GrantID                string `json:"grantId"`
	GrantRevision          int64  `json:"grantRevision"`
	GrantDigest            string `json:"grantDigest"`
	RepositoryID           string `json:"repositoryId"`
	BindingID              string `json:"bindingId"`
	LeaseID                string `json:"leaseId"`
	WorkspaceRef           string `json:"workspaceRef"`
	WorkspaceGeneration    string `json:"workspaceGeneration"`
	RuntimeProfileID       string `json:"runtimeProfileId"`
	RuntimeProfileRevision int64  `json:"runtimeProfileRevision"`
	RuntimeProfileDigest   string `json:"runtimeProfileDigest"`
	PreparedOperationID    string `json:"preparedOperationId"`
	PreparedIntentDigest   string `json:"preparedIntentDigest"`
	PreparedIdentityDigest string `json:"preparedIdentityDigest"`
	BaseCommit             string `json:"baseCommit"`
	PreparedCommit         string `json:"preparedCommit"`
	PreparedTree           string `json:"preparedTree"`
	OutputBaseCommit       string `json:"outputBaseCommit,omitempty"`
	WorkspaceIssuedAt      string `json:"workspaceIssuedAt"`
	WorkspaceExpiresAt     string `json:"workspaceExpiresAt"`
	GrantExpiresAt         string `json:"grantExpiresAt"`
	Deadline               string `json:"deadline"`
}

type runtimeAdmissionRecord struct {
	Version   int                  `json:"version"`
	Owner     Owner                `json:"owner"`
	Spec      RuntimeAdmissionSpec `json:"spec"`
	ClaimedAt string               `json:"claimedAt"`
}

type runtimeStartRecord struct {
	Version            int    `json:"version"`
	RunID              string `json:"runId"`
	AdmissionDigest    string `json:"admissionDigest"`
	AuthorityCheckedAt string `json:"authorityCheckedAt"`
}

type runtimeStopRecord struct {
	Version         int            `json:"version"`
	RunID           string         `json:"runId"`
	AdmissionDigest string         `json:"admissionDigest"`
	StartDigest     string         `json:"startDigest"`
	Outcome         RuntimeOutcome `json:"outcome"`
	StoppedAt       string         `json:"stoppedAt"`
}

// RuntimeAdmissionView is safe restart inventory. It intentionally exposes no
// command, environment value, checkout path or raw filesystem identity.
type RuntimeAdmissionView struct {
	Spec               RuntimeAdmissionSpec `json:"spec"`
	AdmissionDigest    string               `json:"admissionDigest"`
	State              string               `json:"state"`
	ClaimedAt          string               `json:"claimedAt"`
	StartDigest        *string              `json:"startDigest"`
	AuthorityCheckedAt *string              `json:"authorityCheckedAt"`
	Outcome            *RuntimeOutcome      `json:"outcome"`
	StoppedAt          *string              `json:"stoppedAt"`
}

// RuntimeStartAuthority must recheck current authenticated Run/generation,
// cancellation, local grant, prepared identity and Runtime profile authority.
// Success creates no transferable authority; the store writes start-intent
// immediately after it.
type RuntimeStartAuthority func(context.Context, RuntimeAdmissionSpec) error

// RuntimeFenceStore records the local point after which a Runtime may have
// started. A starting record is deliberately not replayable as a fresh start.
type RuntimeFenceStore struct {
	mu      sync.Mutex
	owner   Owner
	root    string
	pins    []directoryPin
	release func() error
	closed  bool
}

// NewRuntimeAdmissionSpec validates and joins exact prerequisite values. It
// proves no current authority and performs no persistence or Runtime effect.
func NewRuntimeAdmissionSpec(manifest execution.GovernedExecutionManifest, prepared repository.PreparedWorkspace, profile RuntimeProfileView) (RuntimeAdmissionSpec, error) {
	raw, err := json.Marshal(manifest)
	if err != nil || wire.ValidateExecutionCommand("executionManifest", raw) != nil {
		return RuntimeAdmissionSpec{}, ErrAdmissionInvalid
	}
	manifestDigest, err := executionDigest(manifest, "manifestDigest")
	if err != nil || manifestDigest != manifest.ManifestDigest {
		return RuntimeAdmissionSpec{}, ErrAdmissionInvalid
	}
	inputDigest, err := executionDigest(manifest.Inputs, "")
	if err != nil || inputDigest != manifest.InputDigest {
		return RuntimeAdmissionSpec{}, ErrAdmissionInvalid
	}
	issued, issuedErr := time.Parse(time.RFC3339Nano, manifest.Workspace.IssuedAt)
	workspaceExpiry, workspaceExpiryErr := time.Parse(time.RFC3339Nano, manifest.Workspace.ExpiresAt)
	grantExpiry, grantExpiryErr := time.Parse(time.RFC3339Nano, manifest.Grant.ExpiresAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, manifest.Deadline)
	profileBoundary := profileBoundary{ExecutableDigest: profile.ExecutableDigest, PermissionProfileDigest: profile.PermissionProfileDigest,
		FilesystemBoundary: profile.FilesystemBoundary, NetworkBoundary: profile.NetworkBoundary, Platform: profile.Platform}
	validPrepared := prepared.Version == 1 && sha256Digest.MatchString(prepared.IntentDigest) && operationID.MatchString(prepared.OperationID) &&
		prepared.RunID == manifest.Scope.RunID && prepared.WorkspaceRef == manifest.Workspace.WorkspaceRef &&
		prepared.Generation == manifest.Workspace.WorkspaceGeneration && prepared.BaseCommit == manifest.Repository.BaseCommit &&
		objectID.MatchString(prepared.BaseCommit) && objectID.MatchString(prepared.PreparedCommit) && objectID.MatchString(prepared.PreparedTree) &&
		len(prepared.BaseCommit) == len(prepared.PreparedCommit) && len(prepared.PreparedCommit) == len(prepared.PreparedTree) &&
		(prepared.OutputBaseCommit == "" || (objectID.MatchString(prepared.OutputBaseCommit) && len(prepared.OutputBaseCommit) == len(prepared.BaseCommit))) &&
		prepared.Path != "" && prepared.GitDirectory != "" && prepared.Branch != "" && prepared.WorkIdentity != ""
	validProfile := validSpec(profile.Spec) && validBoundary(profileBoundary) && sha256Digest.MatchString(profile.Digest) &&
		validProfileTime(profile.RegisteredAt) && profile.RevokedAt == nil && profile.Spec.ProfileID == manifest.Repository.RuntimeProfileID &&
		profile.Digest == manifest.Repository.RuntimeProfileDigest && profile.Spec.AgentID == manifest.Scope.AgentID
	validTime := issuedErr == nil && workspaceExpiryErr == nil && grantExpiryErr == nil && deadlineErr == nil &&
		issued.Before(workspaceExpiry) && issued.Before(grantExpiry) && issued.Before(deadline) &&
		!deadline.After(workspaceExpiry) && !deadline.After(grantExpiry)
	if manifest.Version != 1 || manifest.Workspace.Mode != execution.IsolatedWorktree ||
		manifest.Repository.GrantID != manifest.Grant.GrantID || manifest.Repository.GrantRevision != manifest.Grant.Revision ||
		!validPrepared || !validProfile || !validTime {
		return RuntimeAdmissionSpec{}, ErrAdmissionInvalid
	}
	spec := RuntimeAdmissionSpec{RunID: manifest.Scope.RunID, TaskID: manifest.Scope.TaskID, AgentID: manifest.Scope.AgentID,
		DeviceID: manifest.Scope.DeviceID, PlanID: manifest.Scope.PlanID, PlanRevision: manifest.Scope.PlanRevision,
		PlanDigest: manifest.Scope.PlanDigest, ApprovalOperationID: manifest.Scope.ApprovalOperationID,
		PlanControlRevision: manifest.Scope.PlanControlRevision, NodeKey: manifest.Scope.NodeKey,
		DispatchGeneration: manifest.Scope.DispatchGeneration, RoomID: manifest.Scope.RoomID, TaskRevision: manifest.Scope.TaskRevision,
		DefinitionRevision: manifest.Scope.DefinitionRevision, CriteriaRevision: manifest.Scope.CriteriaRevision, ManifestDigest: manifest.ManifestDigest,
		GrantID: manifest.Grant.GrantID, GrantRevision: manifest.Grant.Revision, GrantDigest: manifest.Grant.Digest, RepositoryID: manifest.Repository.RepositoryID,
		BindingID: manifest.Repository.BindingID, LeaseID: manifest.Workspace.LeaseID, WorkspaceRef: manifest.Workspace.WorkspaceRef,
		WorkspaceGeneration: manifest.Workspace.WorkspaceGeneration, RuntimeProfileID: manifest.Repository.RuntimeProfileID,
		RuntimeProfileRevision: profile.Spec.Revision, RuntimeProfileDigest: manifest.Repository.RuntimeProfileDigest, PreparedOperationID: prepared.OperationID,
		PreparedIntentDigest: prepared.IntentDigest, PreparedIdentityDigest: digest([]byte(prepared.WorkIdentity)),
		BaseCommit: prepared.BaseCommit, PreparedCommit: prepared.PreparedCommit, PreparedTree: prepared.PreparedTree, OutputBaseCommit: prepared.OutputBaseCommit,
		WorkspaceIssuedAt: manifest.Workspace.IssuedAt, WorkspaceExpiresAt: manifest.Workspace.ExpiresAt,
		GrantExpiresAt: manifest.Grant.ExpiresAt, Deadline: manifest.Deadline}
	if !validRuntimeAdmissionSpec(spec) {
		return RuntimeAdmissionSpec{}, ErrAdmissionInvalid
	}
	return spec, nil
}

func OpenRuntimeFenceStore(ctx context.Context, dataDir string, owner Owner) (*RuntimeFenceStore, error) {
	if !validOwner(owner) {
		return nil, ErrAdmissionInvalid
	}
	root, err := canonicalPrivateDirectory(dataDir)
	if err != nil || filepath.Dir(root) == root {
		return nil, ErrAdmissionInvalid
	}
	release, err := ownership.AcquireForContext(ctx, root)
	if err != nil {
		return nil, err
	}
	store := &RuntimeFenceStore{owner: owner, release: release}
	ownerJSON, _ := json.Marshal(owner)
	parent := filepath.Join(root, "runtime-admissions")
	store.root = filepath.Join(parent, digest(ownerJSON))
	for _, directory := range []string{parent, store.root} {
		if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			_ = store.Close()
			return nil, err
		}
		pin, err := pinPrivateDirectory(directory)
		if err != nil {
			_ = store.Close()
			return nil, ErrAdmissionChanged
		}
		store.pins = append(store.pins, pin)
		if err := durablefs.SyncParent(directory); err != nil {
			_ = store.Close()
			return nil, err
		}
	}
	return store, nil
}

func (s *RuntimeFenceStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var first error
	for _, pin := range s.pins {
		if err := pin.file.Close(); err != nil && first == nil {
			first = err
		}
	}
	if err := s.release(); err != nil && first == nil {
		first = err
	}
	return first
}

func (s *RuntimeFenceStore) Claim(spec RuntimeAdmissionSpec, now time.Time) (RuntimeAdmissionView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeAdmissionView{}, err
	}
	if !validRuntimeAdmissionSpec(spec) || now.IsZero() {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	if spec.DeviceID != s.owner.DeviceID {
		return RuntimeAdmissionView{}, ErrAdmissionNotCurrent
	}
	if view, err := s.get(spec.RunID); err == nil {
		if view.Spec != spec {
			return RuntimeAdmissionView{}, ErrAdmissionConflict
		}
		return view, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return RuntimeAdmissionView{}, err
	}
	if !runtimeAdmissionCurrent(spec, now) {
		return RuntimeAdmissionView{}, ErrAdmissionNotCurrent
	}
	views, err := s.list()
	if err != nil {
		return RuntimeAdmissionView{}, err
	}
	if len(views) >= maxRuntimeAdmissions {
		return RuntimeAdmissionView{}, ErrAdmissionConflict
	}
	for _, existing := range views {
		if (existing.Spec.WorkspaceRef == spec.WorkspaceRef && existing.Spec.WorkspaceGeneration == spec.WorkspaceGeneration) ||
			existing.Spec.PreparedIdentityDigest == spec.PreparedIdentityDigest || existing.Spec.PreparedOperationID == spec.PreparedOperationID {
			return RuntimeAdmissionView{}, ErrAdmissionConflict
		}
	}
	record := runtimeAdmissionRecord{Version: 1, Owner: s.owner, Spec: spec, ClaimedAt: profileTime(now)}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	if err := writeExclusive(s.path(spec.RunID, RuntimeAdmissionClaimed), raw); err != nil {
		return RuntimeAdmissionView{}, err
	}
	return s.get(spec.RunID)
}

func (s *RuntimeFenceStore) Get(run string) (RuntimeAdmissionView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeAdmissionView{}, err
	}
	return s.get(run)
}

func (s *RuntimeFenceStore) List() ([]RuntimeAdmissionView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	return s.list()
}

// Start persists the possible-start point after the caller's current-authority
// callback. invoke is true exactly once; every replay is conservative no-start.
func (s *RuntimeFenceStore) Start(ctx context.Context, run, expectedAdmissionDigest string, authorize RuntimeStartAuthority) (RuntimeAdmissionView, bool, error) {
	return s.start(ctx, run, expectedAdmissionDigest, authorize, time.Now)
}

func (s *RuntimeFenceStore) start(ctx context.Context, run, expectedAdmissionDigest string, authorize RuntimeStartAuthority, clock func() time.Time) (RuntimeAdmissionView, bool, error) {
	if authorize == nil || clock == nil || !runID.MatchString(run) || !sha256Digest.MatchString(expectedAdmissionDigest) {
		return RuntimeAdmissionView{}, false, ErrAdmissionInvalid
	}
	s.mu.Lock()
	if err := s.check(); err != nil {
		s.mu.Unlock()
		return RuntimeAdmissionView{}, false, err
	}
	view, err := s.get(run)
	s.mu.Unlock()
	if err != nil {
		return RuntimeAdmissionView{}, false, err
	}
	if view.AdmissionDigest != expectedAdmissionDigest {
		return RuntimeAdmissionView{}, false, ErrAdmissionConflict
	}
	if view.State != RuntimeAdmissionClaimed {
		return view, false, nil
	}
	if err := authorize(ctx, view.Spec); err != nil {
		return RuntimeAdmissionView{}, false, err
	}
	authorizedAt := clock().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeAdmissionView{}, false, err
	}
	current, err := s.get(run)
	if err != nil {
		return RuntimeAdmissionView{}, false, err
	}
	if current.AdmissionDigest != expectedAdmissionDigest || current.Spec != view.Spec {
		return RuntimeAdmissionView{}, false, ErrAdmissionChanged
	}
	if current.State != RuntimeAdmissionClaimed {
		return current, false, nil
	}
	if !runtimeAdmissionCurrent(current.Spec, authorizedAt) {
		return RuntimeAdmissionView{}, false, ErrAdmissionNotCurrent
	}
	record := runtimeStartRecord{Version: 2, RunID: run, AdmissionDigest: expectedAdmissionDigest, AuthorityCheckedAt: profileTime(authorizedAt)}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return RuntimeAdmissionView{}, false, ErrAdmissionInvalid
	}
	if err := writeExclusive(s.path(run, RuntimeAdmissionStarting), raw); err != nil {
		return RuntimeAdmissionView{}, false, err
	}
	current, err = s.get(run)
	return current, err == nil, err
}

func (s *RuntimeFenceStore) Stop(run, expectedAdmissionDigest, expectedStartDigest string, outcome RuntimeOutcome, now time.Time) (RuntimeAdmissionView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeAdmissionView{}, err
	}
	if !validRuntimeOutcome(outcome) || now.IsZero() {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	view, err := s.get(run)
	if err != nil {
		return RuntimeAdmissionView{}, err
	}
	if view.AdmissionDigest != expectedAdmissionDigest || view.StartDigest == nil || *view.StartDigest != expectedStartDigest {
		return RuntimeAdmissionView{}, ErrAdmissionConflict
	}
	if view.State == RuntimeAdmissionStopped {
		if view.Outcome == nil || *view.Outcome != outcome {
			return RuntimeAdmissionView{}, ErrAdmissionConflict
		}
		return view, nil
	}
	started, _ := time.Parse(time.RFC3339Nano, *view.AuthorityCheckedAt)
	if view.State != RuntimeAdmissionStarting || now.UTC().Before(started) {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	record := runtimeStopRecord{Version: 3, RunID: run, AdmissionDigest: expectedAdmissionDigest,
		StartDigest: expectedStartDigest, Outcome: outcome, StoppedAt: profileTime(now)}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	if err := writeExclusive(s.path(run, RuntimeAdmissionStopped), raw); err != nil {
		return RuntimeAdmissionView{}, err
	}
	return s.get(run)
}

// RecoverUnknown closes every durable possible-start record lacking an exact
// stop receipt. The caller must first fence/terminate any surviving process.
func (s *RuntimeFenceStore) RecoverUnknown(now time.Time) ([]RuntimeAdmissionView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil || now.IsZero() {
		if err != nil {
			return nil, err
		}
		return nil, ErrAdmissionInvalid
	}
	views, err := s.list()
	if err != nil {
		return nil, err
	}
	recovered := []RuntimeAdmissionView{}
	for _, view := range views {
		if view.State != RuntimeAdmissionStarting || view.StartDigest == nil || view.AuthorityCheckedAt == nil {
			continue
		}
		started, _ := time.Parse(time.RFC3339Nano, *view.AuthorityCheckedAt)
		if now.UTC().Before(started) {
			return nil, ErrAdmissionInvalid
		}
		record := runtimeStopRecord{Version: 3, RunID: view.Spec.RunID, AdmissionDigest: view.AdmissionDigest,
			StartDigest: *view.StartDigest, Outcome: RuntimeOutcomeUnknown, StoppedAt: profileTime(now)}
		raw, _ := json.Marshal(record)
		if err := writeExclusive(s.path(view.Spec.RunID, RuntimeAdmissionStopped), raw); err != nil {
			return nil, err
		}
		closed, err := s.get(view.Spec.RunID)
		if err != nil {
			return nil, err
		}
		recovered = append(recovered, closed)
	}
	return recovered, nil
}

func (s *RuntimeFenceStore) get(run string) (RuntimeAdmissionView, error) {
	if !runID.MatchString(run) {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	var claim runtimeAdmissionRecord
	if err := readAdmission(s.path(run, RuntimeAdmissionClaimed), &claim); err != nil {
		return RuntimeAdmissionView{}, err
	}
	if claim.Version != 1 || claim.Owner != s.owner || claim.Spec.RunID != run || !validRuntimeAdmissionSpec(claim.Spec) || !validProfileTime(claim.ClaimedAt) {
		return RuntimeAdmissionView{}, ErrAdmissionChanged
	}
	claimDigest, err := runtimeRecordDigest(claim)
	if err != nil {
		return RuntimeAdmissionView{}, ErrAdmissionChanged
	}
	view := RuntimeAdmissionView{Spec: claim.Spec, AdmissionDigest: claimDigest, State: RuntimeAdmissionClaimed, ClaimedAt: claim.ClaimedAt}
	var start runtimeStartRecord
	if err := readAdmission(s.path(run, RuntimeAdmissionStarting), &start); err == nil {
		if start.Version != 2 || start.RunID != run || start.AdmissionDigest != claimDigest || !validProfileTime(start.AuthorityCheckedAt) || start.AuthorityCheckedAt < claim.ClaimedAt {
			return RuntimeAdmissionView{}, ErrAdmissionChanged
		}
		startDigest, err := runtimeRecordDigest(start)
		if err != nil {
			return RuntimeAdmissionView{}, ErrAdmissionChanged
		}
		view.State, view.StartDigest, view.AuthorityCheckedAt = RuntimeAdmissionStarting, &startDigest, &start.AuthorityCheckedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return RuntimeAdmissionView{}, err
	}
	var stop runtimeStopRecord
	if err := readAdmission(s.path(run, RuntimeAdmissionStopped), &stop); err == nil {
		if view.StartDigest == nil || view.AuthorityCheckedAt == nil || stop.Version != 3 || stop.RunID != run ||
			stop.AdmissionDigest != claimDigest || stop.StartDigest != *view.StartDigest || !validRuntimeOutcome(stop.Outcome) ||
			!validProfileTime(stop.StoppedAt) || stop.StoppedAt < *view.AuthorityCheckedAt {
			return RuntimeAdmissionView{}, ErrAdmissionChanged
		}
		view.State, view.Outcome, view.StoppedAt = RuntimeAdmissionStopped, &stop.Outcome, &stop.StoppedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return RuntimeAdmissionView{}, err
	}
	return view, nil
}

func (s *RuntimeFenceStore) list() ([]RuntimeAdmissionView, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	if len(entries) > maxRuntimeAdmissions*3+16 {
		return nil, ErrAdmissionChanged
	}
	claims := []string{}
	stages := map[string]map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".pending-") {
			info, infoErr := entry.Info()
			if infoErr != nil || !info.Mode().IsRegular() || info.Size() > maxProfileRecord ||
				(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
				return nil, ErrAdmissionChanged
			}
			continue
		}
		if entry.IsDir() {
			return nil, ErrAdmissionChanged
		}
		key, stage, ok := runtimeAdmissionFilename(name)
		if !ok || stages[key][stage] {
			return nil, ErrAdmissionChanged
		}
		if stages[key] == nil {
			stages[key] = map[string]bool{}
		}
		stages[key][stage] = true
		if stage == RuntimeAdmissionClaimed {
			claims = append(claims, key)
		}
	}
	for _, present := range stages {
		if !present[RuntimeAdmissionClaimed] || (present[RuntimeAdmissionStopped] && !present[RuntimeAdmissionStarting]) {
			return nil, ErrAdmissionChanged
		}
	}
	views := make([]RuntimeAdmissionView, 0, len(claims))
	for _, key := range claims {
		var record runtimeAdmissionRecord
		if err := readAdmission(filepath.Join(s.root, key+".claimed.json"), &record); err != nil || digest([]byte(record.Spec.RunID)) != key {
			return nil, ErrAdmissionChanged
		}
		view, err := s.get(record.Spec.RunID)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	if len(views) > maxRuntimeAdmissions {
		return nil, ErrAdmissionChanged
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Spec.RunID < views[j].Spec.RunID })
	return views, nil
}

func (s *RuntimeFenceStore) check() error {
	if s.closed {
		return ErrAdmissionChanged
	}
	for _, pin := range s.pins {
		current, err := os.Lstat(pin.path)
		if err != nil || current.Mode()&os.ModeSymlink != 0 || !current.IsDir() || !os.SameFile(current, pin.info) ||
			(runtime.GOOS != "windows" && current.Mode().Perm()&0o077 != 0) {
			return ErrAdmissionChanged
		}
	}
	return nil
}

func (s *RuntimeFenceStore) path(run, stage string) string {
	return filepath.Join(s.root, digest([]byte(run))+"."+stage+".json")
}

func runtimeAdmissionFilename(name string) (string, string, bool) {
	for _, stage := range []string{RuntimeAdmissionClaimed, RuntimeAdmissionStarting, RuntimeAdmissionStopped} {
		suffix := "." + stage + ".json"
		key := strings.TrimSuffix(name, suffix)
		if key != name && sha256Digest.MatchString(key) {
			return key, stage, true
		}
	}
	return "", "", false
}

func readAdmission(path string, target any) error {
	err := readStrict(path, target)
	if errors.Is(err, ErrProfileChanged) {
		return ErrAdmissionChanged
	}
	return err
}

func runtimeRecordDigest(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return wire.ExecutionDigest(raw)
}

func executionDigest(value any, field string) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	if field != "" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return "", err
		}
		delete(fields, field)
		raw, err = json.Marshal(fields)
		if err != nil {
			return "", err
		}
	}
	return wire.ExecutionDigest(raw)
}

func validRuntimeAdmissionSpec(spec RuntimeAdmissionSpec) bool {
	if !runID.MatchString(spec.RunID) || !agentID.MatchString(spec.AgentID) || !profileID.MatchString(spec.RuntimeProfileID) ||
		!operationID.MatchString(spec.ApprovalOperationID) || !operationID.MatchString(spec.PreparedOperationID) ||
		!sha256Digest.MatchString(spec.PlanDigest) || !sha256Digest.MatchString(spec.ManifestDigest) ||
		!sha256Digest.MatchString(spec.GrantDigest) || !sha256Digest.MatchString(spec.RuntimeProfileDigest) ||
		!sha256Digest.MatchString(spec.PreparedIntentDigest) || !sha256Digest.MatchString(spec.PreparedIdentityDigest) ||
		!objectID.MatchString(spec.BaseCommit) || !objectID.MatchString(spec.PreparedCommit) || !objectID.MatchString(spec.PreparedTree) ||
		(spec.OutputBaseCommit != "" && !objectID.MatchString(spec.OutputBaseCommit)) ||
		len(spec.BaseCommit) != len(spec.PreparedCommit) || len(spec.PreparedCommit) != len(spec.PreparedTree) ||
		(spec.OutputBaseCommit != "" && len(spec.OutputBaseCommit) != len(spec.BaseCommit)) ||
		spec.TaskID == "" || spec.DeviceID == "" || spec.PlanID == "" || spec.NodeKey == "" || spec.RoomID == "" || spec.GrantID == "" ||
		spec.RepositoryID == "" || spec.BindingID == "" || spec.LeaseID == "" || spec.WorkspaceRef == "" || spec.WorkspaceGeneration == "" ||
		spec.PlanRevision < 1 || spec.PlanControlRevision < 1 || spec.DispatchGeneration < 1 || spec.TaskRevision < 1 ||
		spec.DefinitionRevision < 1 || spec.CriteriaRevision < 1 || spec.GrantRevision != 1 || spec.RuntimeProfileRevision != 1 {
		return false
	}
	for _, value := range []string{spec.TaskID, spec.DeviceID, spec.PlanID, spec.NodeKey, spec.RoomID, spec.GrantID, spec.RepositoryID,
		spec.BindingID, spec.LeaseID, spec.WorkspaceRef, spec.WorkspaceGeneration} {
		if len(value) > 256 {
			return false
		}
	}
	issued, issuedErr := time.Parse(time.RFC3339Nano, spec.WorkspaceIssuedAt)
	workspaceExpiry, workspaceErr := time.Parse(time.RFC3339Nano, spec.WorkspaceExpiresAt)
	grantExpiry, grantErr := time.Parse(time.RFC3339Nano, spec.GrantExpiresAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, spec.Deadline)
	return issuedErr == nil && workspaceErr == nil && grantErr == nil && deadlineErr == nil && issued.Before(workspaceExpiry) &&
		issued.Before(grantExpiry) && issued.Before(deadline) && !deadline.After(workspaceExpiry) && !deadline.After(grantExpiry)
}

func runtimeAdmissionCurrent(spec RuntimeAdmissionSpec, now time.Time) bool {
	if now.IsZero() {
		return false
	}
	issued, _ := time.Parse(time.RFC3339Nano, spec.WorkspaceIssuedAt)
	workspaceExpiry, _ := time.Parse(time.RFC3339Nano, spec.WorkspaceExpiresAt)
	grantExpiry, _ := time.Parse(time.RFC3339Nano, spec.GrantExpiresAt)
	deadline, _ := time.Parse(time.RFC3339Nano, spec.Deadline)
	now = now.UTC()
	return !now.Before(issued) && now.Before(workspaceExpiry) && now.Before(grantExpiry) && now.Before(deadline)
}

func validRuntimeOutcome(outcome RuntimeOutcome) bool {
	switch outcome {
	case RuntimeOutcomeCompleted, RuntimeOutcomeFailed, RuntimeOutcomeCanceled, RuntimeOutcomeInputRequired, RuntimeOutcomeUnknown:
		return true
	default:
		return false
	}
}
