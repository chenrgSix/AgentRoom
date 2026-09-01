package verification

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrProfileInvalid  = errors.New("local verification profile is invalid")
	ErrProfileChanged  = errors.New("local verification profile executable changed")
	ErrProfileConflict = errors.New("local verification profile conflicts with immutable state")
	ErrProfileRevoked  = errors.New("local verification profile is revoked")
	profileIDPattern   = regexp.MustCompile(`^profile_[A-Za-z0-9_-]{8,128}$`)
	digestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

const (
	profileVersion = 1
	maxProfiles    = 64
	maxRecordBytes = 64 << 10
)

var safeEnvironmentNames = map[string]bool{
	"PATH": true, "LANG": true, "LC_ALL": true, "LC_CTYPE": true,
	"SystemRoot": true, "WINDIR": true,
}

type Owner struct {
	ServerURL     string `json:"serverUrl"`
	TeamID        string `json:"teamId"`
	DeviceID      string `json:"deviceId"`
	OwnerMemberID string `json:"ownerMemberId"`
}

// ProfileSpec is an owner-local command policy. It is never sent to Central.
type ProfileSpec struct {
	ProfileID           string   `json:"profileId"`
	Revision            int64    `json:"revision"`
	Command             []string `json:"command"`
	EnvironmentNames    []string `json:"environmentNames"`
	TimeoutMilliseconds int64    `json:"timeoutMilliseconds"`
	OutputLimitBytes    int64    `json:"outputLimitBytes"`
}

type profileRecord struct {
	Version          int         `json:"version"`
	Owner            Owner       `json:"owner"`
	Spec             ProfileSpec `json:"spec"`
	ExecutableDigest string      `json:"executableDigest"`
	RegisteredAt     string      `json:"registeredAt"`
}

type revocationRecord struct {
	ProfileID string `json:"profileId"`
	Digest    string `json:"digest"`
	Revision  int64  `json:"revision"`
	RevokedAt string `json:"revokedAt"`
}

type ProfileView struct {
	ProfileID           string   `json:"profileId"`
	Revision            int64    `json:"revision"`
	Digest              string   `json:"digest"`
	ExecutableDigest    string   `json:"executableDigest"`
	CommandDigest       string   `json:"commandDigest"`
	EnvironmentNames    []string `json:"environmentNames"`
	TimeoutMilliseconds int64    `json:"timeoutMilliseconds"`
	OutputLimitBytes    int64    `json:"outputLimitBytes"`
	RegisteredAt        string   `json:"registeredAt"`
	RevokedAt           *string  `json:"revokedAt"`
}

type Reference struct {
	ProfileID string
	Revision  int64
	Digest    string
}

type ResolvedProfile struct {
	Reference          Reference
	Executable         string
	Arguments          []string
	EnvironmentNames   []string
	Timeout            time.Duration
	OutputLimitBytes   int64
	ExecutableDigest   string
	RegistrationDigest string
}

type ProfileStore struct {
	mu     sync.Mutex
	owner  Owner
	root   string
	closed bool
}

func OpenProfileStore(dataDir string, owner Owner) (*ProfileStore, error) {
	if !validOwner(owner) || !filepath.IsAbs(dataDir) || filepath.Clean(dataDir) != dataDir {
		return nil, ErrProfileInvalid
	}
	info, err := os.Lstat(dataDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, ErrProfileInvalid
	}
	resolved, err := filepath.EvalSymlinks(dataDir)
	if err != nil {
		return nil, ErrProfileInvalid
	}
	ownerJSON, _ := json.Marshal(owner)
	root := filepath.Join(resolved, "verification-profiles", hash(ownerJSON))
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
	return &ProfileStore{owner: owner, root: root}, nil
}

func DecodeProfileSpec(raw []byte) (ProfileSpec, error) {
	var spec ProfileSpec
	if len(raw) == 0 || len(raw) > maxRecordBytes {
		return spec, ErrProfileInvalid
	}
	canonical, err := wire.CanonicalExecutionJSON(raw)
	if err != nil {
		return spec, ErrProfileInvalid
	}
	decoder := json.NewDecoder(strings.NewReader(string(canonical)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&spec); err != nil {
		return spec, ErrProfileInvalid
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return spec, ErrProfileInvalid
	}
	roundTrip, err := json.Marshal(spec)
	if err != nil {
		return spec, ErrProfileInvalid
	}
	roundTrip, err = wire.CanonicalExecutionJSON(roundTrip)
	if err != nil || string(roundTrip) != string(canonical) {
		return spec, ErrProfileInvalid
	}
	return normalizeSpec(spec)
}

func (s *ProfileStore) Register(spec ProfileSpec, now time.Time) (ProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return ProfileView{}, err
	}
	normalized, err := normalizeSpec(spec)
	if err != nil || now.IsZero() {
		return ProfileView{}, ErrProfileInvalid
	}
	executableDigest, err := executableDigest(normalized.Command[0])
	if err != nil {
		return ProfileView{}, err
	}
	record := profileRecord{Version: profileVersion, Owner: s.owner, Spec: normalized,
		ExecutableDigest: executableDigest, RegisteredAt: now.UTC().Format(time.RFC3339Nano)}
	if previous, view, err := s.get(normalized.ProfileID); err == nil {
		if view.RevokedAt != nil {
			return ProfileView{}, ErrProfileRevoked
		}
		if !sameRecord(previous, record, true) {
			return ProfileView{}, ErrProfileConflict
		}
		return view, durablefs.SyncParent(s.path(normalized.ProfileID, false))
	} else if !errors.Is(err, os.ErrNotExist) {
		return ProfileView{}, err
	}
	views, err := s.list()
	if err != nil || len(views) >= maxProfiles {
		if err != nil {
			return ProfileView{}, err
		}
		return ProfileView{}, ErrProfileInvalid
	}
	raw, _ := json.Marshal(record)
	if len(raw) > maxRecordBytes {
		return ProfileView{}, ErrProfileInvalid
	}
	if err := writeExclusive(s.path(normalized.ProfileID, false), raw); err != nil {
		return ProfileView{}, err
	}
	_, view, err := s.get(normalized.ProfileID)
	return view, err
}

func (s *ProfileStore) List() ([]ProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	return s.list()
}

func (s *ProfileStore) Resolve(reference Reference) (ResolvedProfile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return ResolvedProfile{}, err
	}
	record, view, err := s.get(reference.ProfileID)
	if err != nil {
		return ResolvedProfile{}, err
	}
	if view.RevokedAt != nil {
		return ResolvedProfile{}, ErrProfileRevoked
	}
	if reference.Revision != view.Revision || reference.Digest != view.Digest {
		return ResolvedProfile{}, ErrProfileConflict
	}
	currentDigest, err := executableDigest(record.Spec.Command[0])
	if err != nil || currentDigest != record.ExecutableDigest {
		return ResolvedProfile{}, ErrProfileChanged
	}
	return ResolvedProfile{Reference: reference, Executable: record.Spec.Command[0],
		Arguments:        append([]string{}, record.Spec.Command[1:]...),
		EnvironmentNames: append([]string{}, record.Spec.EnvironmentNames...),
		Timeout:          time.Duration(record.Spec.TimeoutMilliseconds) * time.Millisecond,
		OutputLimitBytes: record.Spec.OutputLimitBytes, ExecutableDigest: record.ExecutableDigest,
		RegistrationDigest: view.Digest}, nil
}

func (s *ProfileStore) Revoke(profileID string, expectedRevision int64, expectedDigest string, now time.Time) (ProfileView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return ProfileView{}, err
	}
	_, view, err := s.get(profileID)
	if err != nil {
		return ProfileView{}, err
	}
	if expectedRevision != 1 || expectedDigest != view.Digest || !digestPattern.MatchString(expectedDigest) || now.IsZero() {
		return ProfileView{}, ErrProfileConflict
	}
	if view.RevokedAt != nil {
		return view, durablefs.SyncParent(s.path(profileID, true))
	}
	revocation := revocationRecord{ProfileID: profileID, Digest: expectedDigest, Revision: 2,
		RevokedAt: now.UTC().Format(time.RFC3339Nano)}
	raw, _ := json.Marshal(revocation)
	if err := writeExclusive(s.path(profileID, true), raw); err != nil {
		return ProfileView{}, err
	}
	_, view, err = s.get(profileID)
	return view, err
}

func (s *ProfileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func (s *ProfileStore) list() ([]ProfileView, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	views := []ProfileView{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type().IsRegular() && strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".revoked.json") {
			id := strings.TrimSuffix(name, ".json")
			if !profileIDPattern.MatchString(id) {
				return nil, ErrProfileChanged
			}
			_, view, err := s.get(id)
			if err != nil {
				return nil, err
			}
			views = append(views, view)
		} else if name != ".DS_Store" && !(entry.Type().IsRegular() && strings.HasSuffix(name, ".revoked.json")) {
			return nil, ErrProfileChanged
		}
	}
	slices.SortFunc(views, func(a, b ProfileView) int { return strings.Compare(a.ProfileID, b.ProfileID) })
	return views, nil
}

func (s *ProfileStore) get(profileID string) (profileRecord, ProfileView, error) {
	var record profileRecord
	if !profileIDPattern.MatchString(profileID) {
		return record, ProfileView{}, ErrProfileInvalid
	}
	if err := readJSON(s.path(profileID, false), &record); err != nil {
		return record, ProfileView{}, err
	}
	normalized, err := normalizeSpec(record.Spec)
	if err != nil || record.Version != profileVersion || record.Owner != s.owner || record.Spec.ProfileID != profileID ||
		record.RegisteredAt == "" || normalized.ProfileID != record.Spec.ProfileID ||
		hash(mustJSON(normalized)) != hash(mustJSON(record.Spec)) {
		return record, ProfileView{}, ErrProfileChanged
	}
	digest, err := recordDigest(record)
	if err != nil {
		return record, ProfileView{}, ErrProfileChanged
	}
	view := ProfileView{ProfileID: profileID, Revision: 1, Digest: digest,
		ExecutableDigest: record.ExecutableDigest, CommandDigest: hash(mustJSON(record.Spec.Command)),
		EnvironmentNames:    append([]string{}, record.Spec.EnvironmentNames...),
		TimeoutMilliseconds: record.Spec.TimeoutMilliseconds, OutputLimitBytes: record.Spec.OutputLimitBytes,
		RegisteredAt: record.RegisteredAt}
	var revoked revocationRecord
	if err := readJSON(s.path(profileID, true), &revoked); err == nil {
		if revoked.ProfileID != profileID || revoked.Digest != digest || revoked.Revision != 2 || revoked.RevokedAt == "" {
			return record, ProfileView{}, ErrProfileChanged
		}
		view.RevokedAt = &revoked.RevokedAt
	} else if !errors.Is(err, os.ErrNotExist) {
		return record, ProfileView{}, err
	}
	return record, view, nil
}

func normalizeSpec(spec ProfileSpec) (ProfileSpec, error) {
	if !profileIDPattern.MatchString(spec.ProfileID) || spec.Revision != 1 || len(spec.Command) == 0 || len(spec.Command) > 32 ||
		!filepath.IsAbs(spec.Command[0]) || filepath.Clean(spec.Command[0]) != spec.Command[0] ||
		spec.TimeoutMilliseconds < 100 || spec.TimeoutMilliseconds > int64((30*time.Minute)/time.Millisecond) ||
		spec.OutputLimitBytes < 1024 || spec.OutputLimitBytes > 1<<20 || len(spec.EnvironmentNames) > 16 {
		return spec, ErrProfileInvalid
	}
	for _, argument := range spec.Command {
		if argument == "" || len(argument) > 4096 || strings.ContainsRune(argument, 0) {
			return spec, ErrProfileInvalid
		}
	}
	result := spec
	result.Command = append([]string{}, spec.Command...)
	result.EnvironmentNames = append([]string{}, spec.EnvironmentNames...)
	slices.Sort(result.EnvironmentNames)
	for index, name := range result.EnvironmentNames {
		if !safeEnvironmentNames[name] || (index > 0 && name == result.EnvironmentNames[index-1]) {
			return spec, ErrProfileInvalid
		}
	}
	return result, nil
}

func executableDigest(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > 512<<20 {
		return "", ErrProfileInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return "", ErrProfileChanged
	}
	hasher := sha256.New()
	read, err := io.Copy(hasher, io.LimitReader(file, info.Size()+1))
	if err != nil || read != info.Size() {
		return "", ErrProfileChanged
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func recordDigest(record profileRecord) (string, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	return wire.ExecutionDigest(raw)
}

func sameRecord(left, right profileRecord, ignoreTime bool) bool {
	if ignoreTime {
		right.RegisteredAt = left.RegisteredAt
	}
	return hash(mustJSON(left)) == hash(mustJSON(right))
}

func validOwner(owner Owner) bool {
	return strings.HasPrefix(owner.TeamID, "team_") && strings.HasPrefix(owner.DeviceID, "device_") &&
		strings.HasPrefix(owner.OwnerMemberID, "member_") && strings.Contains(owner.ServerURL, "://")
}

func (s *ProfileStore) check() error {
	if s == nil || s.closed || !validOwner(s.owner) || !filepath.IsAbs(s.root) {
		return ErrProfileInvalid
	}
	info, err := os.Lstat(s.root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return ErrProfileChanged
	}
	return nil
}

func (s *ProfileStore) path(profileID string, revoked bool) string {
	suffix := ".json"
	if revoked {
		suffix = ".revoked.json"
	}
	return filepath.Join(s.root, profileID+suffix)
}

func readJSON(path string, target any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maxRecordBytes {
		return ErrProfileChanged
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return ErrProfileChanged
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrProfileChanged
	}
	return nil
}

func writeExclusive(path string, raw []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(raw)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	return durablefs.SyncParent(path)
}

func mustJSON(value any) []byte {
	raw, _ := json.Marshal(value)
	return raw
}

func hash(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
