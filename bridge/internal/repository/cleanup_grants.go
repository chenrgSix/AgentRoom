package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
)

var (
	cleanupGrantID     = regexp.MustCompile(`^cleanupgrant_[A-Za-z0-9_-]{8,128}$`)
	cleanupOperationID = regexp.MustCompile(`^op_cleanup_[A-Za-z0-9_-]{8,128}$`)
)

// CleanupGrantSpec is local-only owner consent for one already captured exact
// workspace. It is deliberately not a Runtime capability or shared wire grant.
type CleanupGrantSpec struct {
	GrantID          string `json:"grantId"`
	OperationID      string `json:"operationId"`
	CheckpointID     string `json:"checkpointId"`
	CheckpointDigest string `json:"checkpointDigest"`
	RepositoryID     string `json:"repositoryId"`
	BindingID        string `json:"bindingId"`
	RunID            string `json:"runId"`
	AgentID          string `json:"agentId"`
	DeviceID         string `json:"deviceId"`
	WorkspaceRef     string `json:"workspaceRef"`
	Generation       string `json:"generation"`
	ManifestDigest   string `json:"manifestDigest"`
	PlanID           string `json:"planId"`
	PlanRevision     int64  `json:"planRevision"`
	NodeKey          string `json:"nodeKey"`
	TaskID           string `json:"taskId"`
	ExpiresAt        string `json:"expiresAt"`
}

type cleanupGrantRecord struct {
	Version  int              `json:"version"`
	Owner    BindingOwner     `json:"owner"`
	Spec     CleanupGrantSpec `json:"spec"`
	IssuedAt string           `json:"issuedAt"`
}

type cleanupGrantRevocation struct {
	GrantID   string `json:"grantId"`
	Digest    string `json:"digest"`
	Revision  int64  `json:"revision"`
	RevokedAt string `json:"revokedAt"`
}

type CleanupGrantView struct {
	Spec      CleanupGrantSpec `json:"spec"`
	Revision  int64            `json:"revision"`
	Digest    string           `json:"digest"`
	IssuedAt  string           `json:"issuedAt"`
	RevokedAt *string          `json:"revokedAt"`
}

func (s *BindingStore) IssueCleanupGrant(ctx context.Context, spec CleanupGrantSpec,
	now time.Time) (CleanupGrantView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return CleanupGrantView{}, err
	}
	if err := ctx.Err(); err != nil {
		return CleanupGrantView{}, err
	}
	if now.IsZero() {
		return CleanupGrantView{}, ErrInvalid
	}
	issued := bindingTime(now)
	expires, timeErr := time.Parse(time.RFC3339Nano, spec.ExpiresAt)
	if timeErr != nil {
		return CleanupGrantView{}, ErrInvalid
	}
	spec.ExpiresAt = bindingTime(expires)
	if !validCleanupGrantSpec(spec, s.owner) || !validBindingTime(issued) {
		return CleanupGrantView{}, ErrInvalid
	}
	if !now.UTC().Before(expires.UTC()) {
		return CleanupGrantView{}, ErrGrantExpired
	}
	if err := s.checkCleanupGrantBinding(ctx, spec); err != nil {
		return CleanupGrantView{}, err
	}
	record := cleanupGrantRecord{Version: 1, Owner: s.owner, Spec: spec, IssuedAt: issued}
	if previous, view, err := s.getCleanupGrant(spec.GrantID); err == nil {
		if view.RevokedAt != nil {
			return CleanupGrantView{}, ErrGrantRevoked
		}
		if !reflect.DeepEqual(previous, record) {
			return CleanupGrantView{}, ErrConflict
		}
		return view, durablefs.SyncParent(s.cleanupGrantPath(spec.GrantID, false))
	} else if !errors.Is(err, os.ErrNotExist) {
		return CleanupGrantView{}, err
	}
	views, err := s.listCleanupGrants()
	if err != nil || len(views) >= 256 {
		if err != nil {
			return CleanupGrantView{}, err
		}
		return CleanupGrantView{}, ErrLimit
	}
	raw, _ := json.Marshal(record)
	if len(raw) > 64<<10 {
		return CleanupGrantView{}, ErrLimit
	}
	if err := writeExclusive(s.cleanupGrantPath(spec.GrantID, false), raw); err != nil {
		return CleanupGrantView{}, err
	}
	_, view, err := s.getCleanupGrant(spec.GrantID)
	return view, err
}

func (s *BindingStore) ListCleanupGrants() ([]CleanupGrantView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	return s.listCleanupGrants()
}

func (s *BindingStore) RevokeCleanupGrant(id string, expectedRevision int64,
	expectedDigest string, now time.Time) (CleanupGrantView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return CleanupGrantView{}, err
	}
	_, view, err := s.getCleanupGrant(id)
	if err != nil {
		return CleanupGrantView{}, err
	}
	if view.RevokedAt != nil {
		return view, durablefs.SyncParent(s.cleanupGrantPath(id, true))
	}
	revokedAt := bindingTime(now)
	if expectedRevision != 1 || expectedDigest != view.Digest || !validBindingTime(revokedAt) || revokedAt < view.IssuedAt {
		return CleanupGrantView{}, ErrConflict
	}
	record := cleanupGrantRevocation{GrantID: id, Digest: view.Digest, Revision: 2, RevokedAt: revokedAt}
	raw, _ := json.Marshal(record)
	if err := writeExclusive(s.cleanupGrantPath(id, true), raw); err != nil {
		return CleanupGrantView{}, err
	}
	_, view, err = s.getCleanupGrant(id)
	return view, err
}

// WithCleanupGrantAuthority holds current exact cleanup consent over the
// synchronous callback. Another local command cannot revoke or replace it in
// this lifetime because the BindingStore and outer owner lock remain held.
func (s *BindingStore) WithCleanupGrantAuthority(ctx context.Context, grant string,
	scope CleanupScope, now time.Time, action func() error) error {
	if action == nil || !cleanupGrantID.MatchString(grant) || now.IsZero() {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	record, view, err := s.getCleanupGrant(grant)
	if err != nil {
		return err
	}
	expires, _ := time.Parse(time.RFC3339Nano, record.Spec.ExpiresAt)
	issued, _ := time.Parse(time.RFC3339Nano, record.IssuedAt)
	if view.RevokedAt != nil {
		return ErrGrantRevoked
	}
	if now.Before(issued) || !now.Before(expires) {
		return ErrGrantExpired
	}
	if !cleanupScopeMatches(record.Spec, scope) {
		return ErrGrantDenied
	}
	if err := s.checkCleanupGrantBinding(ctx, record.Spec); err != nil {
		return err
	}
	return action()
}

func cleanupScopeMatches(spec CleanupGrantSpec, scope CleanupScope) bool {
	return spec.OperationID == scope.OperationID && spec.CheckpointID == scope.CheckpointID &&
		spec.CheckpointDigest == scope.CheckpointDigest && spec.RepositoryID == scope.RepositoryID &&
		spec.BindingID == scope.BindingID && spec.RunID == scope.RunID && spec.AgentID == scope.AgentID &&
		spec.DeviceID == scope.DeviceID && spec.WorkspaceRef == scope.WorkspaceRef &&
		spec.Generation == scope.Generation && spec.ManifestDigest == scope.ManifestDigest &&
		spec.PlanID == scope.PlanID && spec.PlanRevision == scope.PlanRevision &&
		spec.NodeKey == scope.NodeKey && spec.TaskID == scope.TaskID
}

func validCleanupGrantSpec(spec CleanupGrantSpec, owner BindingOwner) bool {
	expires, err := time.Parse(time.RFC3339Nano, spec.ExpiresAt)
	return err == nil && bindingTime(expires) == spec.ExpiresAt &&
		cleanupGrantID.MatchString(spec.GrantID) && cleanupOperationID.MatchString(spec.OperationID) &&
		localID.MatchString(spec.CheckpointID) && sha256ID.MatchString(spec.CheckpointDigest) &&
		repositoryID.MatchString(spec.RepositoryID) && bindingID.MatchString(spec.BindingID) &&
		localID.MatchString(spec.RunID) && localID.MatchString(spec.AgentID) &&
		spec.DeviceID == owner.DeviceID && localID.MatchString(spec.WorkspaceRef) &&
		sha256ID.MatchString(spec.Generation) && sha256ID.MatchString(spec.ManifestDigest) &&
		localID.MatchString(spec.PlanID) && spec.PlanRevision > 0 &&
		validCleanupNodeKey(spec.NodeKey) && localID.MatchString(spec.TaskID)
}

func validCleanupNodeKey(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, candidate := range value {
		if !(candidate >= 'a' && candidate <= 'z') && !(candidate >= 'A' && candidate <= 'Z') &&
			!(candidate >= '0' && candidate <= '9') && candidate != '_' && candidate != '-' && candidate != '.' {
			return false
		}
	}
	return true
}

func (s *BindingStore) checkCleanupGrantBinding(ctx context.Context, spec CleanupGrantSpec) error {
	record, view, err := s.get(spec.BindingID)
	if err != nil {
		return err
	}
	if view.RevokedAt != nil {
		return ErrBindingRevoked
	}
	if record.RepositoryID != spec.RepositoryID || s.git.executable == "" {
		return ErrGrantDenied
	}
	current, err := InspectSource(ctx, s.git.executable, record.Source.Root, record.AllowedRoots, s.git.limits)
	if err != nil {
		return err
	}
	if current != record.Source {
		return ErrChanged
	}
	return nil
}

func (s *BindingStore) getCleanupGrant(id string) (cleanupGrantRecord, CleanupGrantView, error) {
	var record cleanupGrantRecord
	if !cleanupGrantID.MatchString(id) {
		return record, CleanupGrantView{}, ErrInvalid
	}
	if err := readBindingJSON(s.cleanupGrantPath(id, false), &record); err != nil {
		return record, CleanupGrantView{}, err
	}
	if record.Version != 1 || record.Owner != s.owner || record.Spec.GrantID != id ||
		!validCleanupGrantSpec(record.Spec, record.Owner) || !validBindingTime(record.IssuedAt) {
		return record, CleanupGrantView{}, ErrChanged
	}
	raw, _ := json.Marshal(record)
	view := CleanupGrantView{Spec: record.Spec, Revision: 1, Digest: digest(string(raw)), IssuedAt: record.IssuedAt}
	var revoked cleanupGrantRevocation
	if err := readBindingJSON(s.cleanupGrantPath(id, true), &revoked); err == nil {
		if revoked.GrantID != id || revoked.Digest != view.Digest || revoked.Revision != 2 ||
			!validBindingTime(revoked.RevokedAt) || revoked.RevokedAt < view.IssuedAt {
			return record, CleanupGrantView{}, ErrChanged
		}
		view.Revision, view.RevokedAt = 2, &revoked.RevokedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return record, CleanupGrantView{}, err
	}
	return record, view, nil
}

func (s *BindingStore) listCleanupGrants() ([]CleanupGrantView, error) {
	entries, err := os.ReadDir(s.cleanupGrantRoot)
	if err != nil {
		return nil, err
	}
	if len(entries) > 1024 {
		return nil, ErrLimit
	}
	views := []CleanupGrantView{}
	seen := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".pending-") {
			continue
		}
		id := strings.TrimSuffix(strings.TrimSuffix(name, ".json"), ".revoked")
		if entry.IsDir() || !strings.HasSuffix(name, ".json") || !cleanupGrantID.MatchString(id) {
			return nil, ErrChanged
		}
		_, view, err := s.getCleanupGrant(id)
		if err != nil {
			return nil, err
		}
		if !strings.HasSuffix(name, ".revoked.json") {
			if seen[id] {
				return nil, ErrChanged
			}
			seen[id], views = true, append(views, view)
		}
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Spec.GrantID < views[j].Spec.GrantID })
	return views, nil
}

func (s *BindingStore) cleanupGrantPath(id string, revoked bool) string {
	if revoked {
		return filepath.Join(s.cleanupGrantRoot, id+".revoked.json")
	}
	return filepath.Join(s.cleanupGrantRoot, id+".json")
}
