package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var ErrBindingRevoked = errors.New("local repository binding is revoked")

// BindingOwner contains no credential. A Central/Team/Device/owner change selects
// another namespace; matching repository names or paths never transfers consent.
type BindingOwner struct {
	ServerURL     string `json:"serverUrl"`
	TeamID        string `json:"teamId"`
	DeviceID      string `json:"deviceId"`
	OwnerMemberID string `json:"ownerMemberId"`
}

// BindRepository is an explicit LOCAL owner command, not a wire request or grant.
type BindRepository struct {
	BindingID    string
	RepositoryID string
	Alias        string
	SelectedRoot string
	AllowedRoots []string
}

type bindingRecord struct {
	Version      int          `json:"version"`
	BindingID    string       `json:"bindingId"`
	RepositoryID string       `json:"repositoryId"`
	Alias        string       `json:"alias"`
	Owner        BindingOwner `json:"owner"`
	AllowedRoots []string     `json:"allowedRoots"`
	Source       Source       `json:"source"`
	RegisteredAt string       `json:"registeredAt"`
}

type bindingRevocation struct {
	BindingID     string `json:"bindingId"`
	BindingDigest string `json:"bindingDigest"`
	Revision      int    `json:"revision"`
	RevokedAt     string `json:"revokedAt"`
}

// BindingView is path-free local inventory, deliberately not a capability or
// RepositoryBindingSummary. Registration alone cannot enable any Runtime.
type BindingView struct {
	BindingID         string  `json:"bindingId"`
	RepositoryID      string  `json:"repositoryId"`
	Alias             string  `json:"alias"`
	Revision          int     `json:"revision"`
	SourceFingerprint string  `json:"sourceFingerprint"`
	RegisteredAt      string  `json:"registeredAt"`
	RevokedAt         *string `json:"revokedAt"`
}

// BindingStore holds the existing Bridge owner lock for its lifetime. A Console
// integration must keep one shared instance when borrowing its existing owner.
// It stores immutable registration, local Task consent and revocation receipts;
// it never deletes Git data. Consent checks alone do not authorize Runtime
// startup, verified execution or integration without their other admission gates.
type BindingStore struct {
	mu               sync.Mutex
	owner            BindingOwner
	dataRoot         string
	root             string
	grantRoot        string
	cleanupGrantRoot string
	pins             map[string]string
	git              gitRunner
	release          func() error
	closed           bool
}

func OpenBindingStore(ctx context.Context, dataDir string, owner BindingOwner, executable string, limits Limits) (*BindingStore, error) {
	if !validBindingOwner(owner) {
		return nil, ErrInvalid
	}
	var git gitRunner
	var err error
	if executable != "" {
		git, err = newGit(executable, limits)
		if err != nil {
			return nil, err
		}
	}
	root, err := canonicalDirectory(dataDir)
	if err != nil || root != dataDir || filepath.Dir(root) == root || !privateDirectory(root) {
		return nil, ErrInvalid
	}
	release, err := ownership.AcquireForContext(ctx, root)
	if err != nil {
		return nil, err
	}
	store := &BindingStore{owner: owner, dataRoot: root, git: git, release: release, pins: map[string]string{}}
	ownerJSON, _ := json.Marshal(owner)
	store.root = filepath.Join(root, "repository-bindings", digest(string(ownerJSON)))
	store.grantRoot = filepath.Join(root, "repository-grants", digest(string(ownerJSON)))
	store.cleanupGrantRoot = filepath.Join(root, "repository-cleanup-grants", digest(string(ownerJSON)))
	for _, dir := range []string{root, filepath.Dir(store.root), store.root, filepath.Dir(store.grantRoot), store.grantRoot,
		filepath.Dir(store.cleanupGrantRoot), store.cleanupGrantRoot} {
		if dir != root {
			if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
				_ = release()
				return nil, err
			}
		}
		pin, err := directoryIdentity(dir)
		if err != nil || !privateDirectory(dir) {
			_ = release()
			return nil, ErrChanged
		}
		store.pins[dir] = pin
		if err := durablefs.SyncParent(dir); err != nil {
			_ = release()
			return nil, err
		}
	}
	return store, nil
}

func (s *BindingStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.release()
}

func (s *BindingStore) Bind(ctx context.Context, input BindRepository, now time.Time) (BindingView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return BindingView{}, err
	}
	if !bindingID.MatchString(input.BindingID) || !repositoryID.MatchString(input.RepositoryID) ||
		!validBindingAlias(input.Alias) || len(input.AllowedRoots) == 0 || len(input.AllowedRoots) > 16 ||
		s.git.executable == "" || now.IsZero() || !validBindingTime(bindingTime(now)) {
		return BindingView{}, ErrInvalid
	}
	existing, previous, err := s.get(input.BindingID)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return BindingView{}, err
	}
	if err == nil && previous.RevokedAt != nil {
		return BindingView{}, ErrBindingRevoked
	}
	roots := make([]string, 0, len(input.AllowedRoots))
	for _, path := range input.AllowedRoots {
		root, err := canonicalDirectory(path)
		if err != nil || filepath.Dir(root) == root {
			return BindingView{}, ErrInvalid
		}
		roots = append(roots, root)
	}
	sort.Strings(roots)
	for i := 1; i < len(roots); i++ {
		if roots[i] == roots[i-1] {
			return BindingView{}, ErrInvalid
		}
	}
	source, err := InspectSource(ctx, s.git.executable, input.SelectedRoot, roots, s.git.limits)
	if err != nil {
		return BindingView{}, err
	}
	if contained(source.Root, s.dataRoot) || contained(s.dataRoot, source.Root) {
		return BindingView{}, ErrInvalid
	}
	record := bindingRecord{Version: 1, BindingID: input.BindingID, RepositoryID: input.RepositoryID,
		Alias: input.Alias, Owner: s.owner, AllowedRoots: roots, Source: source, RegisteredAt: bindingTime(now)}
	if existing.BindingID != "" {
		record.RegisteredAt = existing.RegisteredAt
		if !reflect.DeepEqual(record, existing) {
			return BindingView{}, ErrConflict
		}
		return previous, durablefs.SyncParent(s.path(input.BindingID, false))
	}
	views, err := s.list()
	if err != nil || len(views) >= 256 {
		if err != nil {
			return BindingView{}, err
		}
		return BindingView{}, ErrLimit
	}
	raw, _ := json.Marshal(record)
	if len(raw) > 64<<10 {
		return BindingView{}, ErrLimit
	}
	if err := s.check(); err != nil {
		return BindingView{}, err
	}
	if err := writeExclusive(s.path(input.BindingID, false), raw); err != nil {
		return BindingView{}, err
	}
	_, view, err := s.get(input.BindingID)
	return view, err
}

func (s *BindingStore) List() ([]BindingView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	return s.list()
}

func (s *BindingStore) Revoke(binding string, expectedRevision int, now time.Time) (BindingView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return BindingView{}, err
	}
	if !bindingID.MatchString(binding) || expectedRevision != 1 || now.IsZero() || !validBindingTime(bindingTime(now)) {
		return BindingView{}, ErrConflict
	}
	record, view, err := s.get(binding)
	if err != nil {
		return BindingView{}, err
	}
	if view.RevokedAt != nil {
		return view, durablefs.SyncParent(s.path(binding, true))
	}
	if bindingTime(now) < record.RegisteredAt {
		return BindingView{}, ErrInvalid
	}
	rawRecord, _ := json.Marshal(record)
	receipt := bindingRevocation{BindingID: binding, BindingDigest: digest(string(rawRecord)), Revision: 2, RevokedAt: bindingTime(now)}
	raw, _ := json.Marshal(receipt)
	if err := s.check(); err != nil {
		return BindingView{}, err
	}
	if err := writeExclusive(s.path(binding, true), raw); err != nil {
		return BindingView{}, err
	}
	_, view, err = s.get(binding)
	return view, err
}

// ResolveSource rechecks local physical identity. It is only one prerequisite;
// callers must independently check current Task grants and Runtime enforcement.
func (s *BindingStore) ResolveSource(ctx context.Context, binding, repository string, revision int) (Source, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return Source{}, err
	}
	if s.git.executable == "" {
		return Source{}, ErrIncomplete
	}
	record, view, err := s.get(binding)
	if err != nil {
		return Source{}, err
	}
	if view.RevokedAt != nil {
		return Source{}, ErrBindingRevoked
	}
	if revision != 1 || record.RepositoryID != repository {
		return Source{}, ErrConflict
	}
	current, err := InspectSource(ctx, s.git.executable, record.Source.Root, record.AllowedRoots, s.git.limits)
	if err != nil {
		return Source{}, err
	}
	if current != record.Source {
		return Source{}, ErrChanged
	}
	return current, nil
}

func (s *BindingStore) list() ([]BindingView, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	if len(entries) > 1024 {
		return nil, ErrLimit
	}
	views := []BindingView{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".pending-") {
			continue
		} // Uncommitted crash residue is never consent.
		id := strings.TrimSuffix(name, ".json")
		if strings.HasSuffix(id, ".revoked") {
			id = strings.TrimSuffix(id, ".revoked")
		}
		if !bindingID.MatchString(id) || entry.IsDir() || !strings.HasSuffix(name, ".json") {
			return nil, ErrChanged
		}
		_, view, err := s.get(id)
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

func (s *BindingStore) get(id string) (bindingRecord, BindingView, error) {
	if !bindingID.MatchString(id) {
		return bindingRecord{}, BindingView{}, ErrInvalid
	}
	var record bindingRecord
	if err := readBindingJSON(s.path(id, false), &record); err != nil {
		return record, BindingView{}, err
	}
	if record.Version != 1 || record.BindingID != id || record.Owner != s.owner ||
		!repositoryID.MatchString(record.RepositoryID) || !validBindingAlias(record.Alias) ||
		!validBindingTime(record.RegisteredAt) || len(record.AllowedRoots) == 0 || len(record.AllowedRoots) > 16 ||
		!validBindingPaths(record, s.dataRoot) ||
		(record.Source.ObjectFormat != "sha1" && record.Source.ObjectFormat != "sha256") ||
		record.Source.RootIdentity == "" || record.Source.GitIdentity == "" || record.Source.CommonIdentity == "" {
		return record, BindingView{}, ErrChanged
	}
	sourceJSON, _ := json.Marshal(record.Source)
	view := BindingView{BindingID: id, RepositoryID: record.RepositoryID, Alias: record.Alias, Revision: 1,
		SourceFingerprint: digest(string(sourceJSON)), RegisteredAt: record.RegisteredAt}
	var revoked bindingRevocation
	err := readBindingJSON(s.path(id, true), &revoked)
	if err == nil {
		raw, _ := json.Marshal(record)
		if revoked.BindingID != id || revoked.Revision != 2 || revoked.BindingDigest != digest(string(raw)) ||
			!validBindingTime(revoked.RevokedAt) || revoked.RevokedAt < record.RegisteredAt {
			return record, BindingView{}, ErrChanged
		}
		view.Revision, view.RevokedAt = 2, &revoked.RevokedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return record, BindingView{}, err
	}
	return record, view, nil
}

func (s *BindingStore) path(id string, revoked bool) string {
	if revoked {
		return filepath.Join(s.root, id+".revoked.json")
	}
	return filepath.Join(s.root, id+".json")
}

func (s *BindingStore) check() error {
	if s.closed {
		return ErrIncomplete
	}
	for path, pin := range s.pins {
		current, err := directoryIdentity(path)
		if err != nil || current != pin || !privateDirectory(path) {
			return ErrChanged
		}
	}
	return nil
}

func privateDirectory(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && (runtime.GOOS == "windows" || info.Mode().Perm()&0o077 == 0)
}

func readBindingJSON(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return ErrChanged
	}
	raw, err := readRegular(path, 64<<10)
	if err != nil {
		return err
	}
	canonical, err := wire.CanonicalExecutionJSON(raw)
	if err != nil {
		return ErrChanged
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return ErrChanged
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return ErrChanged
	}
	roundTrip, err := wire.CanonicalExecutionJSON(encoded)
	if err != nil || !bytes.Equal(canonical, roundTrip) {
		return ErrChanged
	}
	return nil
}

var bindingID = regexp.MustCompile(`^repobind_[A-Za-z0-9_-]{8,128}$`)
var repositoryID = regexp.MustCompile(`^repo_[A-Za-z0-9_-]{8,128}$`)

func validBindingOwner(owner BindingOwner) bool {
	if len(owner.ServerURL) > 2048 {
		return false
	}
	parsed, err := url.Parse(owner.ServerURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1")) {
		return false
	}
	for prefix, value := range map[string]string{"team": owner.TeamID, "device": owner.DeviceID, "member": owner.OwnerMemberID} {
		if !regexp.MustCompile(`^` + prefix + `_[A-Za-z0-9_-]{8,128}$`).MatchString(value) {
			return false
		}
	}
	return true
}

func validBindingAlias(alias string) bool {
	if alias == "" || alias == "." || alias == ".." || strings.TrimSpace(alias) != alias || utf8.RuneCountInString(alias) > 80 || !utf8.ValidString(alias) || strings.ContainsAny(alias, `/\\`) {
		return false
	}
	for _, r := range alias {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validBindingPaths(record bindingRecord, dataRoot string) bool {
	clean := func(path string) bool {
		return filepath.IsAbs(path) && filepath.Clean(path) == path && filepath.Dir(path) != path
	}
	for i, root := range record.AllowedRoots {
		if !clean(root) || (i > 0 && record.AllowedRoots[i-1] >= root) {
			return false
		}
	}
	for _, path := range []string{record.Source.Root, record.Source.GitDirectory, record.Source.CommonDirectory} {
		if !clean(path) {
			return false
		}
		allowed := false
		for _, root := range record.AllowedRoots {
			if contained(root, path) {
				allowed = true
			}
		}
		if !allowed {
			return false
		}
	}
	return !contained(record.Source.Root, dataRoot) && !contained(dataRoot, record.Source.Root)
}

func bindingTime(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func validBindingTime(value string) bool {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && bindingTime(parsed) == value
}
