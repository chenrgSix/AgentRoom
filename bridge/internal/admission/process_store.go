package admission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

const governedProcessDirectory = "governed-runtime-processes"

const (
	governedProcessPrepared  = "prepared"
	governedProcessActive    = "active"
	governedProcessFinished  = "finished"
	governedProcessAbandoned = "abandoned"
)

type governedProcessPreparedRecord struct {
	Version    int                                   `json:"version"`
	Owner      Owner                                 `json:"owner"`
	Identity   bridgeruntime.GovernedProcessIdentity `json:"identity"`
	LockDigest string                                `json:"lockDigest"`
	PreparedAt string                                `json:"preparedAt"`
}

type governedProcessActiveRecord struct {
	Version        int                                      `json:"version"`
	RunID          string                                   `json:"runId"`
	PreparedDigest string                                   `json:"preparedDigest"`
	Observation    bridgeruntime.GovernedProcessObservation `json:"observation"`
	StartedAt      string                                   `json:"startedAt"`
}

type governedProcessTerminalRecord struct {
	Version        int    `json:"version"`
	RunID          string `json:"runId"`
	PreparedDigest string `json:"preparedDigest"`
	ActiveDigest   string `json:"activeDigest,omitempty"`
	ClosedAt       string `json:"closedAt"`
}

type governedProcessView struct {
	prepared       governedProcessPreparedRecord
	preparedDigest string
	active         *governedProcessActiveRecord
	activeDigest   string
	terminalStage  string
	terminal       *governedProcessTerminalRecord
}

type GovernedProcessStore struct {
	mu           sync.Mutex
	owner        Owner
	root         string
	pins         []directoryPin
	releaseOwner func() error
	closed       bool
	leases       map[*governedProcessLease]struct{}
	now          func() time.Time
}

type governedProcessLease struct {
	mu             sync.Mutex
	store          *GovernedProcessStore
	identity       bridgeruntime.GovernedProcessIdentity
	preparedDigest string
	lockFile       *os.File
	closed         bool
}

// RuntimeProcessTracker exposes only pre-start lease creation to the Runtime
// runner. RuntimeProcessFencer exposes only restart termination proof to
// delivery recovery; neither wrapper can mutate admission authority.
type RuntimeProcessTracker struct {
	store *GovernedProcessStore
}

func (t *RuntimeProcessTracker) PrepareProcess(identity bridgeruntime.GovernedProcessIdentity) (bridgeruntime.GovernedProcessLease, error) {
	if t == nil || t.store == nil {
		return nil, ErrAdmissionInvalid
	}
	return t.store.PrepareProcess(identity)
}

type RuntimeProcessFencer struct {
	store *GovernedProcessStore
}

// RuntimeProcessCompletion exposes only the exact finished-process proof needed
// before repository capture or workspace retirement. It cannot start, fence or
// mutate a Runtime process.
type RuntimeProcessCompletion struct {
	store *GovernedProcessStore
}

func (f *RuntimeProcessFencer) FenceAll(ctx context.Context) error {
	if f == nil || f.store == nil {
		return ErrAdmissionInvalid
	}
	return f.store.FenceAll(ctx)
}

func (f *RuntimeProcessFencer) FenceAndWait(ctx context.Context, view RuntimeAdmissionView) error {
	if f == nil || f.store == nil {
		return ErrAdmissionInvalid
	}
	return f.store.FenceAndWait(ctx, view)
}

func (p *RuntimeProcessCompletion) RequireFinished(identity bridgeruntime.GovernedProcessIdentity) error {
	if p == nil || p.store == nil {
		return ErrAdmissionInvalid
	}
	return p.store.RequireFinished(identity)
}

// RequireFinished returns nil only for the exact process identity whose active
// process tree was proven absent and durably closed as finished. Prepared-only
// abandonment is not execution evidence.
func (s *GovernedProcessStore) RequireFinished(identity bridgeruntime.GovernedProcessIdentity) error {
	if bridgeruntime.ValidateGovernedProcessIdentity(identity) != nil {
		return ErrAdmissionInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	view, err := s.get(identity.RunID)
	if err != nil {
		return err
	}
	if view.prepared.Identity != identity || view.terminal == nil ||
		view.terminalStage != governedProcessFinished || view.active == nil {
		return ErrAdmissionChanged
	}
	if _, err := os.Lstat(s.lockPath(identity.RunID)); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return err
		}
		return ErrAdmissionChanged
	}
	return nil
}

func (s *GovernedProcessStore) FenceAll(ctx context.Context) error {
	s.mu.Lock()
	if err := s.check(); err != nil {
		s.mu.Unlock()
		return err
	}
	views, err := s.list()
	if err != nil {
		s.mu.Unlock()
		return err
	}
	identities := make([]bridgeruntime.GovernedProcessIdentity, 0, len(views))
	for _, view := range views {
		if view.terminal == nil {
			identities = append(identities, view.prepared.Identity)
		}
	}
	s.mu.Unlock()
	for _, identity := range identities {
		if err := s.FenceAndWait(ctx, governedProcessAdmissionView(identity)); err != nil {
			return err
		}
	}
	return nil
}

func OpenGovernedProcessStore(ctx context.Context, dataDir string, owner Owner) (*GovernedProcessStore, error) {
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
	store := &GovernedProcessStore{owner: owner, releaseOwner: release,
		leases: make(map[*governedProcessLease]struct{}), now: time.Now}
	fail := func(cause error) (*GovernedProcessStore, error) {
		return nil, errors.Join(cause, store.Close())
	}
	ownerJSON, _ := json.Marshal(owner)
	parent := filepath.Join(root, governedProcessDirectory)
	store.root = filepath.Join(parent, digest(ownerJSON))
	for _, directory := range []string{parent, store.root} {
		if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return fail(err)
		}
		pin, err := pinPrivateDirectory(directory)
		if err != nil {
			return fail(ErrAdmissionChanged)
		}
		store.pins = append(store.pins, pin)
		if err := durablefs.SyncParent(directory); err != nil {
			return fail(err)
		}
	}
	return store, nil
}

func (s *GovernedProcessStore) PrepareProcess(identity bridgeruntime.GovernedProcessIdentity) (bridgeruntime.GovernedProcessLease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return nil, err
	}
	if err := bridgeruntime.ValidateGovernedProcessIdentity(identity); err != nil {
		return nil, ErrAdmissionInvalid
	}
	if _, err := s.get(identity.RunID); err == nil {
		return nil, ErrAdmissionConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	views, err := s.list()
	if err != nil {
		return nil, err
	}
	if len(views) >= maxRuntimeAdmissions {
		return nil, ErrAdmissionConflict
	}
	now := s.now().UTC()
	record := governedProcessPreparedRecord{Version: 1, Owner: s.owner, Identity: identity,
		LockDigest: governedProcessLockDigest(identity),
		PreparedAt: profileTime(now)}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return nil, ErrAdmissionInvalid
	}
	preparedDigest, err := runtimeRecordDigest(record)
	if err != nil {
		return nil, ErrAdmissionInvalid
	}
	if err := writeExclusive(s.path(identity.RunID, governedProcessPrepared), raw); err != nil {
		return nil, err
	}
	lockPath := s.lockPath(identity.RunID)
	lockFile, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
	if err == nil {
		err = lockGovernedProcessFile(lockFile)
	}
	if err != nil {
		if lockFile != nil {
			_ = lockFile.Close()
		}
		_ = os.Remove(lockPath)
		_ = s.abandonPreparedLocked(record, preparedDigest, now)
		return nil, err
	}
	if err := durablefs.SyncParent(lockPath); err != nil {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
		_ = s.abandonPreparedLocked(record, preparedDigest, now)
		return nil, err
	}
	lease := &governedProcessLease{store: s, identity: identity,
		preparedDigest: preparedDigest, lockFile: lockFile}
	s.leases[lease] = struct{}{}
	return lease, nil
}

func (s *GovernedProcessStore) FenceAndWait(ctx context.Context, admissionView RuntimeAdmissionView) error {
	if admissionView.State != RuntimeAdmissionStarting || admissionView.StartDigest == nil {
		return ErrAdmissionInvalid
	}
	identity := bridgeruntime.GovernedProcessIdentity{RunID: admissionView.Spec.RunID,
		AdmissionDigest: admissionView.AdmissionDigest, StartDigest: *admissionView.StartDigest}
	if err := bridgeruntime.ValidateGovernedProcessIdentity(identity); err != nil {
		return ErrAdmissionInvalid
	}
	s.mu.Lock()
	if err := s.check(); err != nil {
		s.mu.Unlock()
		return err
	}
	view, err := s.get(identity.RunID)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if view.prepared.Identity != identity {
		s.mu.Unlock()
		return ErrAdmissionConflict
	}
	if view.terminal != nil {
		s.mu.Unlock()
		return nil
	}
	lockPath := s.lockPath(identity.RunID)
	if view.active == nil {
		s.mu.Unlock()
		if err := waitGovernedPreparedAbsent(ctx, lockPath); err != nil {
			return err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := s.check(); err != nil {
			return err
		}
		current, err := s.get(identity.RunID)
		if err != nil || current.prepared.Identity != identity || current.active != nil || current.terminal != nil {
			if err != nil {
				return err
			}
			return ErrAdmissionChanged
		}
		if err := s.abandonPreparedLocked(current.prepared, current.preparedDigest, s.now().UTC()); err != nil {
			return err
		}
		return s.removeLockLocked(identity.RunID)
	}
	observation := view.active.Observation
	s.mu.Unlock()
	if err := fenceGovernedProcess(ctx, observation, lockPath); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	current, err := s.get(identity.RunID)
	if err != nil || current.prepared.Identity != identity || current.active == nil ||
		current.active.Observation != observation {
		if err != nil {
			return err
		}
		return ErrAdmissionChanged
	}
	if current.terminal != nil {
		return nil
	}
	return s.finishActiveLocked(current, s.now().UTC())
}

func governedProcessAdmissionView(identity bridgeruntime.GovernedProcessIdentity) RuntimeAdmissionView {
	startDigest := identity.StartDigest
	return RuntimeAdmissionView{State: RuntimeAdmissionStarting, AdmissionDigest: identity.AdmissionDigest,
		StartDigest: &startDigest, Spec: RuntimeAdmissionSpec{RunID: identity.RunID}}
}

func (s *GovernedProcessStore) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	leases := make([]*governedProcessLease, 0, len(s.leases))
	for lease := range s.leases {
		leases = append(leases, lease)
	}
	s.leases = nil
	pins := s.pins
	s.pins = nil
	releaseOwner := s.releaseOwner
	s.releaseOwner = nil
	s.mu.Unlock()
	var result error
	for _, lease := range leases {
		lease.mu.Lock()
		if lease.lockFile != nil {
			result = errors.Join(result, lease.lockFile.Close())
			lease.lockFile = nil
		}
		lease.closed = true
		lease.mu.Unlock()
	}
	for _, pin := range pins {
		result = errors.Join(result, pin.file.Close())
	}
	if releaseOwner != nil {
		result = errors.Join(result, releaseOwner())
	}
	return result
}

func (l *governedProcessLease) InheritedLockFile() *os.File {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	return l.lockFile
}

func (l *governedProcessLease) Started(observation bridgeruntime.GovernedProcessObservation) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.store == nil {
		return ErrAdmissionChanged
	}
	err := l.store.startLease(l, observation)
	if l.lockFile != nil {
		err = errors.Join(err, l.lockFile.Close())
		l.lockFile = nil
	}
	return err
}

func (l *governedProcessLease) Finished(observation bridgeruntime.GovernedProcessObservation) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.store == nil {
		return ErrAdmissionChanged
	}
	if l.lockFile != nil {
		_ = l.lockFile.Close()
		l.lockFile = nil
	}
	err := l.store.finishLease(l, observation)
	l.closed = err == nil
	return err
}

func (l *governedProcessLease) Abandon() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.store == nil {
		return nil
	}
	if l.lockFile != nil {
		_ = l.lockFile.Close()
		l.lockFile = nil
	}
	err := l.store.abandonLease(l)
	l.closed = err == nil
	return err
}

func (s *GovernedProcessStore) startLease(lease *governedProcessLease,
	observation bridgeruntime.GovernedProcessObservation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil || !validGovernedProcessObservation(observation) {
		if err != nil {
			return err
		}
		return ErrAdmissionInvalid
	}
	view, err := s.get(lease.identity.RunID)
	if err != nil || view.prepared.Identity != lease.identity || view.preparedDigest != lease.preparedDigest ||
		view.active != nil || view.terminal != nil {
		if err != nil {
			return err
		}
		return ErrAdmissionChanged
	}
	record := governedProcessActiveRecord{Version: 2, RunID: lease.identity.RunID,
		PreparedDigest: lease.preparedDigest, Observation: observation, StartedAt: profileTime(s.now().UTC())}
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return ErrAdmissionInvalid
	}
	return writeExclusive(s.path(lease.identity.RunID, governedProcessActive), raw)
}

func (s *GovernedProcessStore) finishLease(lease *governedProcessLease,
	observation bridgeruntime.GovernedProcessObservation) error {
	s.mu.Lock()
	if err := s.check(); err != nil {
		s.mu.Unlock()
		return err
	}
	view, err := s.get(lease.identity.RunID)
	if err != nil || view.prepared.Identity != lease.identity || view.preparedDigest != lease.preparedDigest {
		s.mu.Unlock()
		if err != nil {
			return err
		}
		return ErrAdmissionChanged
	}
	if view.terminal != nil {
		delete(s.leases, lease)
		s.mu.Unlock()
		return nil
	}
	if view.active == nil {
		if err := s.abandonPreparedLocked(view.prepared, view.preparedDigest, s.now().UTC()); err != nil {
			s.mu.Unlock()
			return err
		}
		delete(s.leases, lease)
		removeErr := s.removeLockLocked(lease.identity.RunID)
		s.mu.Unlock()
		return removeErr
	}
	if view.active.Observation != observation {
		s.mu.Unlock()
		return ErrAdmissionConflict
	}
	s.mu.Unlock()
	if err := fenceGovernedProcess(context.Background(), observation, s.lockPath(lease.identity.RunID)); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	view, err = s.get(lease.identity.RunID)
	if err != nil || view.prepared.Identity != lease.identity || view.preparedDigest != lease.preparedDigest ||
		view.active == nil || view.active.Observation != observation {
		if err != nil {
			return err
		}
		return ErrAdmissionChanged
	}
	if view.terminal == nil {
		if err := s.finishActiveLocked(view, s.now().UTC()); err != nil {
			return err
		}
	}
	delete(s.leases, lease)
	return nil
}

func (s *GovernedProcessStore) abandonLease(lease *governedProcessLease) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return err
	}
	view, err := s.get(lease.identity.RunID)
	if err != nil || view.prepared.Identity != lease.identity || view.preparedDigest != lease.preparedDigest || view.active != nil {
		if err != nil {
			return err
		}
		return ErrAdmissionChanged
	}
	if view.terminal == nil {
		if err := s.abandonPreparedLocked(view.prepared, view.preparedDigest, s.now().UTC()); err != nil {
			return err
		}
	}
	delete(s.leases, lease)
	return s.removeLockLocked(lease.identity.RunID)
}

func (s *GovernedProcessStore) abandonPreparedLocked(prepared governedProcessPreparedRecord,
	preparedDigest string, now time.Time) error {
	record := governedProcessTerminalRecord{Version: 3, RunID: prepared.Identity.RunID,
		PreparedDigest: preparedDigest, ClosedAt: profileTime(now)}
	return s.writeTerminalLocked(prepared.Identity.RunID, governedProcessAbandoned, record)
}

func (s *GovernedProcessStore) finishActiveLocked(view governedProcessView, now time.Time) error {
	record := governedProcessTerminalRecord{Version: 3, RunID: view.prepared.Identity.RunID,
		PreparedDigest: view.preparedDigest, ActiveDigest: view.activeDigest, ClosedAt: profileTime(now)}
	if err := s.writeTerminalLocked(view.prepared.Identity.RunID, governedProcessFinished, record); err != nil {
		return err
	}
	return s.removeLockLocked(view.prepared.Identity.RunID)
}

func (s *GovernedProcessStore) writeTerminalLocked(runID, stage string,
	record governedProcessTerminalRecord) error {
	raw, err := json.Marshal(record)
	if err != nil || len(raw) > maxProfileRecord {
		return ErrAdmissionInvalid
	}
	return writeExclusive(s.path(runID, stage), raw)
}

func (s *GovernedProcessStore) removeLockLocked(runID string) error {
	path := s.lockPath(runID)
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return durablefs.SyncParent(path)
}

func (s *GovernedProcessStore) get(run string) (governedProcessView, error) {
	if !runID.MatchString(run) {
		return governedProcessView{}, ErrAdmissionInvalid
	}
	var prepared governedProcessPreparedRecord
	if err := readAdmission(s.path(run, governedProcessPrepared), &prepared); err != nil {
		return governedProcessView{}, err
	}
	if prepared.Version != 1 || prepared.Owner != s.owner || prepared.Identity.RunID != run ||
		bridgeruntime.ValidateGovernedProcessIdentity(prepared.Identity) != nil ||
		prepared.LockDigest != governedProcessLockDigest(prepared.Identity) || !validProfileTime(prepared.PreparedAt) {
		return governedProcessView{}, ErrAdmissionChanged
	}
	preparedDigest, err := runtimeRecordDigest(prepared)
	if err != nil {
		return governedProcessView{}, ErrAdmissionChanged
	}
	view := governedProcessView{prepared: prepared, preparedDigest: preparedDigest}
	var active governedProcessActiveRecord
	if err := readAdmission(s.path(run, governedProcessActive), &active); err == nil {
		if active.Version != 2 || active.RunID != run || active.PreparedDigest != preparedDigest ||
			!validGovernedProcessObservation(active.Observation) || !validProfileTime(active.StartedAt) ||
			active.StartedAt < prepared.PreparedAt {
			return governedProcessView{}, ErrAdmissionChanged
		}
		activeDigest, err := runtimeRecordDigest(active)
		if err != nil {
			return governedProcessView{}, ErrAdmissionChanged
		}
		view.active, view.activeDigest = &active, activeDigest
	} else if !errors.Is(err, os.ErrNotExist) {
		return governedProcessView{}, err
	}
	for _, stage := range []string{governedProcessFinished, governedProcessAbandoned} {
		var terminal governedProcessTerminalRecord
		if err := readAdmission(s.path(run, stage), &terminal); err == nil {
			if view.terminal != nil || terminal.Version != 3 || terminal.RunID != run ||
				terminal.PreparedDigest != preparedDigest || !validProfileTime(terminal.ClosedAt) ||
				terminal.ClosedAt < prepared.PreparedAt ||
				(stage == governedProcessFinished && (view.active == nil || terminal.ActiveDigest != view.activeDigest ||
					terminal.ClosedAt < view.active.StartedAt)) ||
				(stage == governedProcessAbandoned && (view.active != nil || terminal.ActiveDigest != "")) {
				return governedProcessView{}, ErrAdmissionChanged
			}
			view.terminalStage, view.terminal = stage, &terminal
		} else if !errors.Is(err, os.ErrNotExist) {
			return governedProcessView{}, err
		}
	}
	return view, nil
}

func (s *GovernedProcessStore) list() ([]governedProcessView, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	if len(entries) > maxRuntimeAdmissions*5+16 {
		return nil, ErrAdmissionChanged
	}
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
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return nil, ErrAdmissionChanged
		}
		info, infoErr := entry.Info()
		key, stage, ok := governedProcessFilename(name)
		if !ok || infoErr != nil || !info.Mode().IsRegular() || info.Size() > maxProfileRecord ||
			(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
			return nil, ErrAdmissionChanged
		}
		if stages[key] == nil {
			stages[key] = map[string]bool{}
		}
		if stages[key][stage] {
			return nil, ErrAdmissionChanged
		}
		stages[key][stage] = true
	}
	views := make([]governedProcessView, 0, len(stages))
	for key, present := range stages {
		if !present[governedProcessPrepared] {
			return nil, ErrAdmissionChanged
		}
		var prepared governedProcessPreparedRecord
		if err := readAdmission(filepath.Join(s.root, key+"."+governedProcessPrepared+".json"), &prepared); err != nil ||
			digest([]byte(prepared.Identity.RunID)) != key {
			return nil, ErrAdmissionChanged
		}
		view, err := s.get(prepared.Identity.RunID)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func governedProcessFilename(name string) (string, string, bool) {
	for _, stage := range []string{governedProcessPrepared, governedProcessActive,
		governedProcessFinished, governedProcessAbandoned} {
		suffix := "." + stage + ".json"
		key := strings.TrimSuffix(name, suffix)
		if key != name && sha256Digest.MatchString(key) {
			return key, stage, true
		}
	}
	key := strings.TrimSuffix(name, ".process.lock")
	return key, "lock", key != name && sha256Digest.MatchString(key)
}

func (s *GovernedProcessStore) path(runID, stage string) string {
	return filepath.Join(s.root, digest([]byte(runID))+"."+stage+".json")
}

func (s *GovernedProcessStore) lockPath(runID string) string {
	return filepath.Join(s.root, digest([]byte(runID))+".process.lock")
}

func (s *GovernedProcessStore) check() error {
	if s == nil || s.closed || s.now == nil {
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

func governedProcessLockDigest(identity bridgeruntime.GovernedProcessIdentity) string {
	return digest([]byte(identity.RunID + "\x00" + identity.AdmissionDigest + "\x00" + identity.StartDigest))
}
