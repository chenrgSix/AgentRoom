package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrGrantRevoked = errors.New("local Task grant is revoked")
	ErrGrantExpired = errors.New("local Task grant is outside its validity interval")
	ErrGrantDenied  = errors.New("execution does not match the local Task grant")
	grantID         = regexp.MustCompile(`^grant_[A-Za-z0-9_-]{8,128}$`)
	grantTaskID     = regexp.MustCompile(`^task_[A-Za-z0-9_-]{8,128}$`)
	grantRoomID     = regexp.MustCompile(`^room_[A-Za-z0-9_-]{8,128}$`)
)

// TaskGrantSpec is a LOCAL owner command, not another wire model or a claim
// that Central approved this plan. Generated wire types own shared policy
// values. Extra local pins prevent consent from following a changed Task/plan.
// Profile references grant consent only to those exact fingerprints; actual
// local profile resolution and enforced Runtime admission remain mandatory.
type TaskGrantSpec struct {
	GrantID              string                                               `json:"grantId"`
	BindingID            string                                               `json:"bindingId"`
	BindingRevision      int                                                  `json:"bindingRevision"`
	SourceFingerprint    string                                               `json:"sourceFingerprint"`
	RepositoryID         string                                               `json:"repositoryId"`
	BaseCommit           string                                               `json:"baseCommit"`
	PlanID               string                                               `json:"planId"`
	PlanRevision         int64                                                `json:"planRevision"`
	PlanDigest           string                                               `json:"planDigest"`
	NodeKey              string                                               `json:"nodeKey"`
	RoomID               string                                               `json:"roomId"`
	TaskID               string                                               `json:"taskId"`
	DefinitionRevision   int64                                                `json:"definitionRevision"`
	CriteriaRevision     int64                                                `json:"criteriaRevision"`
	AgentID              string                                               `json:"agentId"`
	ExpiresAt            string                                               `json:"expiresAt"`
	Operations           []execution.KindElement                              `json:"operations"`
	RuntimeProfile       execution.ExecutionGrantSummaryRuntimeProfile        `json:"runtimeProfile"`
	VerificationProfiles []execution.ExecutionGrantSummaryVerificationProfile `json:"verificationProfiles"`
	ScopePolicy          execution.ExecutionGrantSummaryScopePolicy           `json:"scopePolicy"`
	IntegrationTargets   []execution.ExecutionGrantSummaryIntegrationTarget   `json:"integrationTargets"`
}

type taskGrantRecord struct {
	Version  int           `json:"version"`
	Owner    BindingOwner  `json:"owner"`
	Spec     TaskGrantSpec `json:"spec"`
	IssuedAt string        `json:"issuedAt"`
}

type taskGrantRevocation struct {
	GrantID   string `json:"grantId"`
	Digest    string `json:"digest"`
	Revision  int64  `json:"revision"`
	RevokedAt string `json:"revokedAt"`
}

// TaskGrantView preserves the original consent and a separate reduction-only
// revocation revision. Summary.Grant.Digest always identifies the immutable
// issuance record; a revoked summary is never valid execution authority.
type TaskGrantView struct {
	Spec    TaskGrantSpec                   `json:"spec"`
	Summary execution.ExecutionGrantSummary `json:"summary"`
}

// DecodeTaskGrantSpec rejects duplicate/case-folded/unknown fields, omitted
// fields, replacement Unicode, and trailing JSON before local administration.
func DecodeTaskGrantSpec(raw []byte) (TaskGrantSpec, error) {
	var spec TaskGrantSpec
	if len(raw) > 64<<10 {
		return spec, ErrLimit
	}
	canonical, err := wire.CanonicalExecutionJSON(raw)
	if err != nil {
		return spec, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&spec) != nil {
		return spec, ErrInvalid
	}
	encoded, err := json.Marshal(spec)
	if err != nil {
		return spec, ErrInvalid
	}
	roundTrip, err := wire.CanonicalExecutionJSON(encoded)
	if err != nil || !bytes.Equal(roundTrip, canonical) {
		return spec, ErrInvalid
	}
	return spec, nil
}

func (s *BindingStore) IssueTaskGrant(ctx context.Context, spec TaskGrantSpec, now time.Time) (TaskGrantView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return TaskGrantView{}, err
	}
	if now.IsZero() || !validBindingTime(bindingTime(now)) {
		return TaskGrantView{}, ErrInvalid
	}
	normalized, err := normalizeTaskGrant(spec, s.owner, bindingTime(now))
	if err != nil {
		return TaskGrantView{}, err
	}
	previous, view, err := s.getTaskGrant(normalized.GrantID)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return TaskGrantView{}, err
	}
	if err == nil {
		if view.Summary.RevokedAt != nil {
			return TaskGrantView{}, ErrGrantRevoked
		}
		if !reflect.DeepEqual(previous.Spec, normalized) {
			return TaskGrantView{}, ErrConflict
		}
	}
	expires, _ := time.Parse(time.RFC3339Nano, normalized.ExpiresAt)
	if !now.Before(expires) || (previous.IssuedAt != "" && bindingTime(now) < previous.IssuedAt) {
		return TaskGrantView{}, ErrGrantExpired
	}
	if err := s.checkGrantBinding(ctx, normalized); err != nil {
		return TaskGrantView{}, err
	}
	if previous.IssuedAt != "" {
		return view, durablefs.SyncParent(s.grantPath(normalized.GrantID, false))
	}
	views, err := s.listTaskGrants()
	if err != nil {
		return TaskGrantView{}, err
	}
	if len(views) >= 256 {
		return TaskGrantView{}, ErrLimit
	}
	record := taskGrantRecord{Version: 1, Owner: s.owner, Spec: normalized, IssuedAt: bindingTime(now)}
	raw, _ := json.Marshal(record)
	if err := s.check(); err != nil {
		return TaskGrantView{}, err
	}
	if err := writeExclusive(s.grantPath(normalized.GrantID, false), raw); err != nil {
		return TaskGrantView{}, err
	}
	_, view, err = s.getTaskGrant(normalized.GrantID)
	return view, err
}

func (s *BindingStore) ListTaskGrants() ([]TaskGrantView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	return s.listTaskGrants()
}

// RevokeTaskGrant requires the exact reviewed issuance digest. It works without
// Git, the checkout or an unexpired credential and never removes any data.
func (s *BindingStore) RevokeTaskGrant(id string, expectedRevision int64, expectedDigest string, now time.Time) (TaskGrantView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return TaskGrantView{}, err
	}
	if expectedRevision != 1 || !sha256ID.MatchString(expectedDigest) {
		return TaskGrantView{}, ErrConflict
	}
	record, view, err := s.getTaskGrant(id)
	if err != nil {
		return TaskGrantView{}, err
	}
	if view.Summary.Grant.Digest != expectedDigest {
		return TaskGrantView{}, ErrConflict
	}
	if view.Summary.RevokedAt != nil {
		return view, durablefs.SyncParent(s.grantPath(id, true))
	}
	if now.IsZero() || !validBindingTime(bindingTime(now)) || bindingTime(now) < record.IssuedAt {
		return TaskGrantView{}, ErrInvalid
	}
	receipt := taskGrantRevocation{GrantID: id, Digest: expectedDigest, Revision: 2, RevokedAt: bindingTime(now)}
	raw, _ := json.Marshal(receipt)
	if err := s.check(); err != nil {
		return TaskGrantView{}, err
	}
	if err := writeExclusive(s.grantPath(id, true), raw); err != nil {
		return TaskGrantView{}, err
	}
	_, view, err = s.getTaskGrant(id)
	return view, err
}

// CheckTaskGrant checks only the current local consent prerequisite. It is NOT
// permission to start a Runtime: callers must also resolve actual local
// profiles, enforce their sandbox, validate Central authority, and hold the
// existing Run/generation fence. Integration/external IO use separate admission.
func (s *BindingStore) CheckTaskGrant(ctx context.Context, manifest execution.GovernedExecutionManifest, operation execution.KindElement, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	raw, err := json.Marshal(manifest)
	if err != nil || wire.ValidateExecutionCommand("executionManifest", raw) != nil {
		return ErrInvalid
	}
	manifestDigest, err := executionValueDigest(manifest, "manifestDigest")
	if err != nil || manifestDigest != manifest.ManifestDigest {
		return ErrInvalid
	}
	inputDigest, err := executionValueDigest(manifest.Inputs, "")
	if err != nil || inputDigest != manifest.InputDigest {
		return ErrInvalid
	}
	record, view, err := s.getTaskGrant(manifest.Grant.GrantID)
	if err != nil {
		return err
	}
	if view.Summary.RevokedAt != nil {
		return ErrGrantRevoked
	}
	expires, _ := time.Parse(time.RFC3339Nano, record.Spec.ExpiresAt)
	issued, _ := time.Parse(time.RFC3339Nano, record.IssuedAt)
	deadline, _ := time.Parse(time.RFC3339Nano, manifest.Deadline)
	if now.Before(issued) || !now.Before(expires) || !now.Before(deadline) || deadline.After(expires) {
		return ErrGrantExpired
	}
	spec, scope, repo := record.Spec, manifest.Scope, manifest.Repository
	if operation != execution.Prepare && operation != execution.Capture && operation != execution.Verify {
		return ErrGrantDenied
	}
	if !slices.Contains(spec.Operations, operation) ||
		manifest.Grant != execution.GovernedExecutionManifestGrant(view.Summary.Grant) ||
		repo.GrantID != spec.GrantID || repo.GrantRevision != 1 ||
		repo.BindingID != spec.BindingID || repo.RepositoryID != spec.RepositoryID || repo.BaseCommit != spec.BaseCommit ||
		repo.RuntimeProfileID != spec.RuntimeProfile.ProfileID || repo.RuntimeProfileDigest != spec.RuntimeProfile.Digest ||
		scope.DeviceID != s.owner.DeviceID || scope.AgentID != spec.AgentID || scope.RoomID != spec.RoomID ||
		scope.TaskID != spec.TaskID || scope.DefinitionRevision != spec.DefinitionRevision || scope.CriteriaRevision != spec.CriteriaRevision ||
		scope.PlanID != spec.PlanID || scope.PlanRevision != spec.PlanRevision || scope.PlanDigest != spec.PlanDigest || scope.NodeKey != spec.NodeKey {
		return ErrGrantDenied
	}
	if !scopeWithinGrant(execution.ManifestScopePolicy(manifest.ScopePolicy), execution.ManifestScopePolicy(spec.ScopePolicy)) {
		return ErrGrantDenied
	}
	seen := map[string]bool{}
	for _, profile := range manifest.VerificationProfiles {
		pin := execution.ExecutionGrantSummaryVerificationProfile{ProfileID: profile.ProfileID, Revision: profile.Revision, Digest: profile.Digest}
		if seen[profile.ProfileID] || !slices.Contains(spec.VerificationProfiles, pin) {
			return ErrGrantDenied
		}
		seen[profile.ProfileID] = true
	}
	return s.checkGrantBinding(ctx, spec)
}

// CheckIntegrationGrant validates a distinct owner-local consent chain for one
// exact repository target. It grants no Runtime preparation, capture or
// verification authority and does not itself authorize a Git ref mutation;
// callers must also hold the exact Central integration operation and its
// retained verification proof.
func (s *BindingStore) CheckIntegrationGrant(ctx context.Context, operation execution.RepositoryOperationRequest, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	raw, err := json.Marshal(operation)
	if err != nil || wire.ValidateExecutionCommand("repositoryOperation", raw) != nil {
		return ErrInvalid
	}
	requestDigest, err := executionValueDigest(operation, "requestDigest")
	if err != nil || requestDigest != operation.RequestDigest || operation.Execution == nil ||
		operation.Action.Kind != execution.Integrate || operation.Action.Integrate == nil {
		return ErrInvalid
	}
	record, view, err := s.getTaskGrant(operation.Grant.GrantID)
	if err != nil {
		return err
	}
	if view.Summary.RevokedAt != nil {
		return ErrGrantRevoked
	}
	expires, _ := time.Parse(time.RFC3339Nano, record.Spec.ExpiresAt)
	issued, _ := time.Parse(time.RFC3339Nano, record.IssuedAt)
	deadline, _ := time.Parse(time.RFC3339Nano, operation.Deadline)
	if now.IsZero() || now.Before(issued) || !now.Before(expires) || !now.Before(deadline) || deadline.After(expires) {
		return ErrGrantExpired
	}
	spec, scope, target := record.Spec, operation.Execution, operation.Action.Integrate.Target
	if len(spec.Operations) != 1 || spec.Operations[0] != execution.Integrate || len(spec.IntegrationTargets) != 1 ||
		operation.Grant.GrantID != view.Summary.Grant.GrantID || operation.Grant.Revision != view.Summary.Grant.Revision ||
		operation.Grant.Digest != view.Summary.Grant.Digest || operation.Grant.ExpiresAt != view.Summary.Grant.ExpiresAt ||
		operation.BindingID != spec.BindingID || operation.RepositoryID != spec.RepositoryID || operation.DeviceID != s.owner.DeviceID ||
		operation.Plan.PlanID != spec.PlanID || operation.Plan.Revision != spec.PlanRevision || operation.Plan.Digest != spec.PlanDigest ||
		operation.Plan.RoomID != spec.RoomID || scope.PlanID != spec.PlanID || scope.PlanRevision != spec.PlanRevision ||
		scope.PlanDigest != spec.PlanDigest || scope.NodeKey != spec.NodeKey || scope.RoomID != spec.RoomID ||
		scope.TaskID != spec.TaskID || scope.DefinitionRevision != spec.DefinitionRevision || scope.CriteriaRevision != spec.CriteriaRevision ||
		scope.AgentID != spec.AgentID || scope.DeviceID != s.owner.DeviceID || target.RepositoryID != spec.RepositoryID ||
		target.RepositoryID != operation.RepositoryID || spec.IntegrationTargets[0] != execution.ExecutionGrantSummaryIntegrationTarget(target) {
		return ErrGrantDenied
	}
	return s.checkGrantBinding(ctx, spec)
}

func (s *BindingStore) checkGrantBinding(ctx context.Context, spec TaskGrantSpec) error {
	record, binding, err := s.get(spec.BindingID)
	if err != nil {
		return err
	}
	if binding.RevokedAt != nil {
		return ErrBindingRevoked
	}
	if spec.BindingRevision != binding.Revision || spec.SourceFingerprint != binding.SourceFingerprint || spec.RepositoryID != binding.RepositoryID {
		return ErrGrantDenied
	}
	if s.git.executable == "" {
		return ErrIncomplete
	}
	if (record.Source.ObjectFormat == "sha1" && len(spec.BaseCommit) != 40) ||
		(record.Source.ObjectFormat == "sha256" && len(spec.BaseCommit) != 64) {
		return ErrGrantDenied
	}
	current, err := InspectSource(ctx, s.git.executable, record.Source.Root, record.AllowedRoots, s.git.limits)
	if err != nil {
		return err
	}
	if current != record.Source {
		return ErrChanged
	}
	return s.check()
}

func normalizeTaskGrant(spec TaskGrantSpec, owner BindingOwner, issuedAt string) (TaskGrantSpec, error) {
	// Clone all caller-owned slices before normalization and before persistence.
	raw, err := json.Marshal(spec)
	if err != nil || len(raw) > 64<<10 {
		return spec, ErrInvalid
	}
	var cloned TaskGrantSpec
	if err := json.Unmarshal(raw, &cloned); err != nil {
		return spec, ErrInvalid
	}
	spec = cloned
	if !grantID.MatchString(spec.GrantID) || spec.BindingRevision != 1 || !sha256ID.MatchString(spec.SourceFingerprint) ||
		!grantTaskID.MatchString(spec.TaskID) || !grantRoomID.MatchString(spec.RoomID) || !sha256ID.MatchString(spec.PlanDigest) ||
		!objectID.MatchString(spec.BaseCommit) || !validGrantRevision(spec.PlanRevision) ||
		!validGrantRevision(spec.DefinitionRevision) || !validGrantRevision(spec.CriteriaRevision) {
		return spec, ErrInvalid
	}
	// Schema validation precedes normalization so null and duplicate arrays are
	// not repaired into an apparently valid owner request.
	record := taskGrantRecord{Version: 1, Owner: owner, Spec: spec, IssuedAt: issuedAt}
	recordJSON, err := json.Marshal(record)
	if err != nil || len(recordJSON) > 64<<10 {
		return spec, ErrLimit
	}
	if _, err := taskGrantSummary(record); err != nil {
		return spec, ErrInvalid
	}
	policy, err := freezeScopePolicy(execution.ManifestScopePolicy(spec.ScopePolicy))
	if err != nil {
		return spec, err
	}
	spec.ScopePolicy = execution.ExecutionGrantSummaryScopePolicy(policy)
	slices.Sort(spec.Operations)
	slices.SortFunc(spec.VerificationProfiles, func(a, b execution.ExecutionGrantSummaryVerificationProfile) int {
		return strings.Compare(a.ProfileID, b.ProfileID)
	})
	for i, profile := range spec.VerificationProfiles {
		if i > 0 && profile.ProfileID == spec.VerificationProfiles[i-1].ProfileID {
			return spec, ErrInvalid
		}
	}
	slices.SortFunc(spec.IntegrationTargets, func(a, b execution.ExecutionGrantSummaryIntegrationTarget) int {
		return strings.Compare(a.TargetRef, b.TargetRef)
	})
	for i, target := range spec.IntegrationTargets {
		if target.RepositoryID != spec.RepositoryID || !validGrantTarget(target.TargetRef) ||
			(i > 0 && target.TargetRef == spec.IntegrationTargets[i-1].TargetRef) {
			return spec, ErrInvalid
		}
	}
	return spec, nil
}

func taskGrantSummary(record taskGrantRecord) (execution.ExecutionGrantSummary, error) {
	spec := record.Spec
	raw, _ := json.Marshal(record)
	digest, err := wire.ExecutionDigest(raw)
	if err != nil {
		return execution.ExecutionGrantSummary{}, err
	}
	summary := execution.ExecutionGrantSummary{AgentID: spec.AgentID, BindingID: spec.BindingID, DeviceID: record.Owner.DeviceID,
		Grant:        execution.ExecutionGrantSummaryGrant{GrantID: spec.GrantID, Revision: 1, Digest: digest, ExpiresAt: spec.ExpiresAt},
		RepositoryID: spec.RepositoryID, PlanID: spec.PlanID, NodeKey: spec.NodeKey, Operations: spec.Operations,
		RuntimeProfile: spec.RuntimeProfile, VerificationProfiles: spec.VerificationProfiles, ScopePolicy: spec.ScopePolicy,
		IntegrationTargets: spec.IntegrationTargets, IssuedAt: record.IssuedAt}
	raw, _ = json.Marshal(summary)
	return summary, wire.ValidateExecutionCommand("executionGrant", raw)
}

func (s *BindingStore) getTaskGrant(id string) (taskGrantRecord, TaskGrantView, error) {
	var record taskGrantRecord
	if !grantID.MatchString(id) {
		return record, TaskGrantView{}, ErrInvalid
	}
	if err := readBindingJSON(s.grantPath(id, false), &record); err != nil {
		return record, TaskGrantView{}, err
	}
	if record.Version != 1 || record.Owner != s.owner || record.Spec.GrantID != id || !validBindingTime(record.IssuedAt) {
		return record, TaskGrantView{}, ErrChanged
	}
	normalized, err := normalizeTaskGrant(record.Spec, record.Owner, record.IssuedAt)
	expires, timeErr := time.Parse(time.RFC3339Nano, record.Spec.ExpiresAt)
	issued, _ := time.Parse(time.RFC3339Nano, record.IssuedAt)
	if err != nil || !reflect.DeepEqual(normalized, record.Spec) || timeErr != nil || !issued.Before(expires) {
		return record, TaskGrantView{}, ErrChanged
	}
	summary, err := taskGrantSummary(record)
	if err != nil {
		return record, TaskGrantView{}, ErrChanged
	}
	var revoked taskGrantRevocation
	if err := readBindingJSON(s.grantPath(id, true), &revoked); err == nil {
		if revoked.GrantID != id || revoked.Revision != 2 || revoked.Digest != summary.Grant.Digest ||
			!validBindingTime(revoked.RevokedAt) || revoked.RevokedAt < record.IssuedAt {
			return record, TaskGrantView{}, ErrChanged
		}
		summary.Grant.Revision, summary.RevokedAt = 2, &revoked.RevokedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return record, TaskGrantView{}, err
	}
	return record, TaskGrantView{Spec: record.Spec, Summary: summary}, nil
}

func (s *BindingStore) listTaskGrants() ([]TaskGrantView, error) {
	entries, err := os.ReadDir(s.grantRoot)
	if err != nil {
		return nil, err
	}
	if len(entries) > 1024 {
		return nil, ErrLimit
	}
	views := []TaskGrantView{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".pending-") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimSuffix(name, ".json"), ".revoked")
		if !grantID.MatchString(id) || entry.IsDir() || !strings.HasSuffix(name, ".json") {
			return nil, ErrChanged
		}
		_, view, err := s.getTaskGrant(id)
		if err != nil {
			return nil, err
		}
		if !strings.HasSuffix(name, ".revoked.json") {
			views = append(views, view)
		}
	}
	if len(views) > 256 {
		return nil, ErrLimit
	}
	return views, nil
}

func (s *BindingStore) grantPath(id string, revoked bool) string {
	if revoked {
		return filepath.Join(s.grantRoot, id+".revoked.json")
	}
	return filepath.Join(s.grantRoot, id+".json")
}

func validGrantRevision(value int64) bool { return value > 0 && value <= 9007199254740991 }

func validGrantTarget(ref string) bool {
	if !strings.HasPrefix(ref, "refs/heads/") || strings.ContainsAny(ref, " ~^:?*[\\") || strings.Contains(ref, "..") || strings.Contains(ref, "@{") {
		return false
	}
	for _, part := range strings.Split(ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
		for _, r := range part {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}

func scopeWithinGrant(request, grant execution.ManifestScopePolicy) bool {
	var err error
	if request, err = freezeScopePolicy(request); err != nil {
		return false
	}
	if grant, err = freezeScopePolicy(grant); err != nil {
		return false
	}
	if grant.RequirePreventivePathEnforcement && !request.RequirePreventivePathEnforcement {
		return false
	}
	if request.Access == execution.ReadOnly {
		return true
	}
	if grant.Access != execution.IsolatedWrite {
		return false
	}
	for _, allowed := range request.AllowedPaths {
		if !slices.ContainsFunc(grant.AllowedPaths, func(parent string) bool { return prefixContains(parent, allowed) }) {
			return false
		}
		for _, denied := range grant.ForbiddenPaths {
			intersection := denied
			if prefixContains(denied, allowed) {
				intersection = allowed
			} else if !prefixContains(allowed, denied) {
				continue
			}
			if !slices.ContainsFunc(request.ForbiddenPaths, func(parent string) bool { return prefixContains(parent, intersection) }) {
				return false
			}
		}
	}
	return true
}
