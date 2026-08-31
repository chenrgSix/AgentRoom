package admission

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	localruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrProfileInvalid     = errors.New("local Runtime profile is invalid")
	ErrProfileChanged     = errors.New("local Runtime profile state changed")
	ErrProfileConflict    = errors.New("local Runtime profile conflicts with immutable state")
	ErrProfileRevoked     = errors.New("local Runtime profile is revoked")
	ErrProfileDenied      = errors.New("local Runtime profile does not match the requested grant")
	ErrProfileUnsupported = errors.New("local Runtime profile kind is unsupported")
	profileID             = regexp.MustCompile(`^profile_[A-Za-z0-9_-]{8,128}$`)
	agentID               = regexp.MustCompile(`^agent_[A-Za-z0-9_-]{8,128}$`)
	sha256Digest          = regexp.MustCompile(`^[a-f0-9]{64}$`)
	permissionProfileName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
)

const (
	CodexRuntimeKind       = "codex"
	FilesystemBoundaryName = "workspace_write_outside_deny"
	NetworkBoundaryName    = "ipv4_loopback_connect_deny"
	maxProfiles            = 64
	maxProfileRecord       = 64 << 10
)

// Owner selects one exact paired local namespace. It contains no credential.
type Owner struct {
	ServerURL     string `json:"serverUrl"`
	TeamID        string `json:"teamId"`
	DeviceID      string `json:"deviceId"`
	OwnerMemberID string `json:"ownerMemberId"`
}

// RuntimeProfileSpec is path-free owner intent. ConfigurationDigest binds the
// selected local Agent command and environment-name policy without persisting
// either local values or paths.
type RuntimeProfileSpec struct {
	ProfileID           string `json:"profileId"`
	Revision            int64  `json:"revision"`
	AgentID             string `json:"agentId"`
	RuntimeKind         string `json:"runtimeKind"`
	ConfigurationDigest string `json:"configurationDigest"`
	PermissionProfile   string `json:"permissionProfile"`
}

type profileBoundary struct {
	ExecutableDigest        string `json:"executableDigest"`
	PermissionProfileDigest string `json:"permissionProfileDigest"`
	FilesystemBoundary      string `json:"filesystemBoundary"`
	NetworkBoundary         string `json:"networkBoundary"`
	Platform                string `json:"platform"`
}

type profileRecord struct {
	Version      int                `json:"version"`
	Owner        Owner              `json:"owner"`
	Spec         RuntimeProfileSpec `json:"spec"`
	Boundary     profileBoundary    `json:"boundary"`
	RegisteredAt string             `json:"registeredAt"`
}

type profileRevocation struct {
	ProfileID string `json:"profileId"`
	Digest    string `json:"digest"`
	Revision  int64  `json:"revision"`
	RevokedAt string `json:"revokedAt"`
}

// RuntimeProfileView is safe local inventory. It deliberately omits Owner,
// command, environment, paths, listener address and physical canaries.
type RuntimeProfileView struct {
	Spec                    RuntimeProfileSpec `json:"spec"`
	Digest                  string             `json:"digest"`
	ExecutableDigest        string             `json:"executableDigest"`
	PermissionProfileDigest string             `json:"permissionProfileDigest"`
	FilesystemBoundary      string             `json:"filesystemBoundary"`
	NetworkBoundary         string             `json:"networkBoundary"`
	Platform                string             `json:"platform"`
	RegisteredAt            string             `json:"registeredAt"`
	RevokedAt               *string            `json:"revokedAt"`
}

type CodexRegistration struct {
	Spec    RuntimeProfileSpec
	Agent   config.AgentConfig
	Timeout time.Duration
}

type codexBoundaryProber func(context.Context, localruntime.CodexLocalBoundaryProbe, time.Time) (localruntime.CodexLocalBoundaryProbeResult, error)

type directoryPin struct {
	path string
	file *os.File
	info os.FileInfo
}

// ProfileStore owns immutable Runtime profile registrations under the existing
// Bridge process-owner fence. A positive record is still not startup authority;
// admission must resolve its exact digest and rerun the physical probe.
type ProfileStore struct {
	mu        sync.Mutex
	owner     Owner
	root      string
	probeRoot string
	pins      []directoryPin
	release   func() error
	closed    bool
}

func OpenProfileStore(ctx context.Context, dataDir string, owner Owner) (*ProfileStore, error) {
	if !validOwner(owner) {
		return nil, ErrProfileInvalid
	}
	root, err := canonicalPrivateDirectory(dataDir)
	if err != nil || filepath.Dir(root) == root {
		return nil, ErrProfileInvalid
	}
	release, err := ownership.AcquireForContext(ctx, root)
	if err != nil {
		return nil, err
	}
	store := &ProfileStore{owner: owner, release: release}
	ownerJSON, _ := json.Marshal(owner)
	namespace := digest(ownerJSON)
	parent := filepath.Join(root, "runtime-profiles")
	probeParent := filepath.Join(root, "runtime-profile-probes")
	store.root = filepath.Join(parent, namespace)
	store.probeRoot = filepath.Join(probeParent, namespace)
	for _, directory := range []string{parent, store.root, probeParent, store.probeRoot} {
		if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			_ = store.Close()
			return nil, err
		}
		pin, err := pinPrivateDirectory(directory)
		if err != nil {
			_ = store.Close()
			return nil, err
		}
		store.pins = append(store.pins, pin)
		if err := durablefs.SyncParent(directory); err != nil {
			_ = store.Close()
			return nil, err
		}
	}
	return store, nil
}

func (s *ProfileStore) Close() error {
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

func (s *ProfileStore) RegisterCodex(ctx context.Context, input CodexRegistration, now time.Time) (RuntimeProfileView, error) {
	return s.registerCodex(ctx, input, now, localruntime.ProbeCodexLocalBoundary)
}

func (s *ProfileStore) registerCodex(ctx context.Context, input CodexRegistration, now time.Time, prober codexBoundaryProber) (RuntimeProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeProfileView{}, err
	}
	if !validSpec(input.Spec) || input.Spec.RuntimeKind != CodexRuntimeKind || prober == nil || now.IsZero() {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	configurationDigest, err := CodexConfigurationDigest(input.Agent, input.Spec.AgentID, input.Spec.PermissionProfile)
	if err != nil || configurationDigest != input.Spec.ConfigurationDigest {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	environment, err := codexProbeEnvironment(input.Agent.EnvAllowlist)
	if err != nil {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	previous, view, err := s.get(input.Spec.ProfileID)
	if err == nil {
		if view.RevokedAt != nil {
			return RuntimeProfileView{}, ErrProfileRevoked
		}
		if previous.Spec != input.Spec {
			return RuntimeProfileView{}, ErrProfileConflict
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return RuntimeProfileView{}, err
	} else {
		views, listErr := s.list()
		if listErr != nil {
			return RuntimeProfileView{}, listErr
		}
		if len(views) >= maxProfiles {
			return RuntimeProfileView{}, ErrProfileInvalid
		}
	}
	workspace, outside, cleanup, err := s.probeRoots()
	if err != nil {
		return RuntimeProfileView{}, err
	}
	cleaned := false
	defer func() {
		if !cleaned {
			_ = cleanup()
		}
	}()
	probe := localruntime.CodexLocalBoundaryProbe{Command: append([]string{}, input.Agent.Command...), Environment: environment,
		Workspace: workspace, OutsideRoot: outside, PermissionProfile: input.Spec.PermissionProfile, Timeout: input.Timeout}
	result, err := prober(ctx, probe, now)
	if err != nil {
		return RuntimeProfileView{}, err
	}
	probedAt, probedAtErr := time.Parse(time.RFC3339Nano, result.ProbedAt)
	boundary := profileBoundary{ExecutableDigest: result.ExecutableDigest, PermissionProfileDigest: result.PermissionProfileDigest,
		FilesystemBoundary: result.FilesystemBoundary, NetworkBoundary: result.NetworkBoundary, Platform: result.Platform}
	if !validBoundary(boundary) || result.PermissionProfile != input.Spec.PermissionProfile || probedAtErr != nil || !probedAt.Equal(now) {
		return RuntimeProfileView{}, ErrProfileDenied
	}
	if err := cleanup(); err != nil {
		return RuntimeProfileView{}, err
	}
	cleaned = true
	if err := s.check(); err != nil {
		return RuntimeProfileView{}, err
	}
	previous, view, err = s.get(input.Spec.ProfileID)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return RuntimeProfileView{}, err
	}
	if err == nil {
		if view.RevokedAt != nil {
			return RuntimeProfileView{}, ErrProfileRevoked
		}
		if previous.Spec != input.Spec || previous.Boundary != boundary {
			return RuntimeProfileView{}, ErrProfileConflict
		}
		return view, durablefs.SyncParent(s.path(input.Spec.ProfileID, false))
	}
	views, err := s.list()
	if err != nil {
		return RuntimeProfileView{}, err
	}
	if len(views) >= maxProfiles {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	record := profileRecord{Version: 1, Owner: s.owner, Spec: input.Spec, Boundary: boundary, RegisteredAt: profileTime(now)}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	if err := s.check(); err != nil {
		return RuntimeProfileView{}, err
	}
	if err := writeExclusive(s.path(input.Spec.ProfileID, false), raw); err != nil {
		return RuntimeProfileView{}, err
	}
	_, view, err = s.get(input.Spec.ProfileID)
	return view, err
}

func (s *ProfileStore) List() ([]RuntimeProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	return s.list()
}

func (s *ProfileStore) Revoke(profile string, expectedRevision int64, expectedDigest string, now time.Time) (RuntimeProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeProfileView{}, err
	}
	if expectedRevision != 1 || !sha256Digest.MatchString(expectedDigest) || now.IsZero() {
		return RuntimeProfileView{}, ErrProfileConflict
	}
	record, view, err := s.get(profile)
	if err != nil {
		return RuntimeProfileView{}, err
	}
	if view.Digest != expectedDigest {
		return RuntimeProfileView{}, ErrProfileConflict
	}
	if view.RevokedAt != nil {
		return view, durablefs.SyncParent(s.path(profile, true))
	}
	when := profileTime(now)
	if when < record.RegisteredAt {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	revocation := profileRevocation{ProfileID: profile, Digest: expectedDigest, Revision: 2, RevokedAt: when}
	raw, err := json.Marshal(revocation)
	if err != nil {
		return RuntimeProfileView{}, ErrProfileInvalid
	}
	if err := s.check(); err != nil {
		return RuntimeProfileView{}, err
	}
	if err := writeExclusive(s.path(profile, true), raw); err != nil {
		return RuntimeProfileView{}, err
	}
	_, view, err = s.get(profile)
	return view, err
}

func (s *ProfileStore) ResolveRuntime(reference execution.ExecutionGrantSummaryRuntimeProfile, stableAgentID string, agent config.AgentConfig) (RuntimeProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return RuntimeProfileView{}, err
	}
	_, view, err := s.get(reference.ProfileID)
	if err != nil {
		return RuntimeProfileView{}, err
	}
	if view.RevokedAt != nil {
		return RuntimeProfileView{}, ErrProfileRevoked
	}
	configurationDigest, err := CodexConfigurationDigest(agent, stableAgentID, view.Spec.PermissionProfile)
	if err != nil || reference.Revision != 1 || reference.Digest != view.Digest || view.Spec.AgentID != stableAgentID ||
		view.Spec.ConfigurationDigest != configurationDigest || view.Spec.RuntimeKind != CodexRuntimeKind {
		return RuntimeProfileView{}, ErrProfileDenied
	}
	return view, nil
}

func (s *ProfileStore) get(id string) (profileRecord, RuntimeProfileView, error) {
	var record profileRecord
	if !profileID.MatchString(id) {
		return record, RuntimeProfileView{}, ErrProfileInvalid
	}
	if err := readStrict(s.path(id, false), &record); err != nil {
		return record, RuntimeProfileView{}, err
	}
	if record.Version != 1 || record.Owner != s.owner || record.Spec.ProfileID != id || !validSpec(record.Spec) ||
		!validBoundary(record.Boundary) || !validProfileTime(record.RegisteredAt) {
		return record, RuntimeProfileView{}, ErrProfileChanged
	}
	digestValue, err := recordDigest(record)
	if err != nil {
		return record, RuntimeProfileView{}, ErrProfileChanged
	}
	view := RuntimeProfileView{Spec: record.Spec, Digest: digestValue, ExecutableDigest: record.Boundary.ExecutableDigest,
		PermissionProfileDigest: record.Boundary.PermissionProfileDigest, FilesystemBoundary: record.Boundary.FilesystemBoundary,
		NetworkBoundary: record.Boundary.NetworkBoundary, Platform: record.Boundary.Platform, RegisteredAt: record.RegisteredAt}
	var revoked profileRevocation
	if err := readStrict(s.path(id, true), &revoked); err == nil {
		if revoked.ProfileID != id || revoked.Digest != digestValue || revoked.Revision != 2 ||
			!validProfileTime(revoked.RevokedAt) || revoked.RevokedAt < record.RegisteredAt {
			return record, RuntimeProfileView{}, ErrProfileChanged
		}
		view.RevokedAt = &revoked.RevokedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return record, RuntimeProfileView{}, err
	}
	return record, view, nil
}

func (s *ProfileStore) list() ([]RuntimeProfileView, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	if len(entries) > maxProfiles*2+16 {
		return nil, ErrProfileChanged
	}
	views := []RuntimeProfileView{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".pending-") {
			info, infoErr := entry.Info()
			if infoErr != nil || !info.Mode().IsRegular() || info.Size() > maxProfileRecord ||
				(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
				return nil, ErrProfileChanged
			}
			continue
		}
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			return nil, ErrProfileChanged
		}
		if strings.HasSuffix(name, ".revoked.json") {
			id := strings.TrimSuffix(name, ".revoked.json")
			if !profileID.MatchString(id) {
				return nil, ErrProfileChanged
			}
			if _, err := os.Lstat(s.path(id, false)); err != nil {
				return nil, ErrProfileChanged
			}
			continue
		}
		id := strings.TrimSuffix(name, ".json")
		if !profileID.MatchString(id) {
			return nil, ErrProfileChanged
		}
		_, view, err := s.get(id)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	if len(views) > maxProfiles {
		return nil, ErrProfileChanged
	}
	sort.Slice(views, func(i, j int) bool { return views[i].Spec.ProfileID < views[j].Spec.ProfileID })
	return views, nil
}

func (s *ProfileStore) path(id string, revoked bool) string {
	if revoked {
		return filepath.Join(s.root, id+".revoked.json")
	}
	return filepath.Join(s.root, id+".json")
}

func (s *ProfileStore) probeRoots() (string, string, func() error, error) {
	workspace, err := os.MkdirTemp(s.probeRoot, ".probe-workspace-")
	if err != nil {
		return "", "", nil, err
	}
	outside, err := os.MkdirTemp(s.probeRoot, ".probe-outside-")
	if err != nil {
		_ = os.RemoveAll(workspace)
		return "", "", nil, err
	}
	cleanup := func() error {
		first := os.RemoveAll(workspace)
		second := os.RemoveAll(outside)
		for _, path := range []string{workspace, outside} {
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) && first == nil {
				first = ErrProfileChanged
			}
		}
		if first != nil {
			return first
		}
		return second
	}
	return workspace, outside, cleanup, nil
}

func (s *ProfileStore) check() error {
	if s.closed {
		return ErrProfileChanged
	}
	for _, pin := range s.pins {
		current, err := os.Lstat(pin.path)
		if err != nil || current.Mode()&os.ModeSymlink != 0 || !current.IsDir() || !os.SameFile(current, pin.info) ||
			(runtime.GOOS != "windows" && current.Mode().Perm()&0o077 != 0) {
			return ErrProfileChanged
		}
	}
	return nil
}

func validSpec(spec RuntimeProfileSpec) bool {
	return profileID.MatchString(spec.ProfileID) && spec.Revision == 1 && agentID.MatchString(spec.AgentID) &&
		spec.RuntimeKind == CodexRuntimeKind && sha256Digest.MatchString(spec.ConfigurationDigest) &&
		permissionProfileName.MatchString(spec.PermissionProfile)
}

func validBoundary(value profileBoundary) bool {
	return sha256Digest.MatchString(value.ExecutableDigest) && sha256Digest.MatchString(value.PermissionProfileDigest) &&
		value.FilesystemBoundary == FilesystemBoundaryName && value.NetworkBoundary == NetworkBoundaryName &&
		regexp.MustCompile(`^darwin/(amd64|arm64)$`).MatchString(value.Platform)
}

func validOwner(owner Owner) bool {
	parsed, err := url.Parse(owner.ServerURL)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || len(owner.ServerURL) > 2048 {
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

func canonicalPrivateDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", ErrProfileInvalid
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != path {
		return "", ErrProfileInvalid
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return "", ErrProfileInvalid
	}
	return path, nil
}

func pinPrivateDirectory(path string) (directoryPin, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return directoryPin{}, ErrProfileChanged
	}
	file, err := os.Open(path)
	if err != nil {
		return directoryPin{}, err
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		_ = file.Close()
		return directoryPin{}, ErrProfileChanged
	}
	return directoryPin{path: path, file: file, info: actual}, nil
}

func readStrict(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > maxProfileRecord ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return ErrProfileChanged
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return ErrProfileChanged
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxProfileRecord+1))
	if err != nil || len(raw) > maxProfileRecord {
		return ErrProfileChanged
	}
	canonical, err := wire.CanonicalExecutionJSON(raw)
	if err != nil {
		return ErrProfileChanged
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(new(any)) != io.EOF {
		return ErrProfileChanged
	}
	encoded, err := json.Marshal(target)
	if err != nil {
		return ErrProfileChanged
	}
	roundTrip, err := wire.CanonicalExecutionJSON(encoded)
	if err != nil || !bytes.Equal(canonical, roundTrip) {
		return ErrProfileChanged
	}
	return nil
}

func writeExclusive(path string, raw []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	_, writeErr := file.Write(raw)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Link(temporary, path); err != nil {
		return err
	}
	return durablefs.SyncParent(path)
}

func recordDigest(record profileRecord) (string, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	return wire.ExecutionDigest(raw)
}

func digest(raw []byte) string {
	value := sha256.Sum256(raw)
	return hex.EncodeToString(value[:])
}

func profileTime(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func validProfileTime(value string) bool {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && profileTime(parsed) == value
}
