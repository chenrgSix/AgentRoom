package admission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
)

const governedPreparationDirectory = "governed-preparation"

// GovernedAdmissionResources owns the local stores needed by one coordinator.
// Opening it starts no Runtime and advertises no capability.
type GovernedAdmissionResources struct {
	mu           sync.Mutex
	coordinator  *GovernedAdmissionCoordinator
	bindings     *repository.BindingStore
	preparer     *repository.Preparer
	profiles     *ProfileStore
	fence        *RuntimeFenceStore
	releaseOwner func() error
	closed       bool
}

func OpenGovernedAdmissionResources(ctx context.Context, cfg config.Config, credential pairing.Credential,
	gitExecutable string, agents map[string]config.AgentConfig) (*GovernedAdmissionResources, error) {
	dataDir, err := canonicalPrivateDirectory(cfg.DataDir)
	if err != nil || dataDir != cfg.DataDir {
		return nil, ErrAdmissionInvalid
	}
	if strings.TrimSpace(credential.Token) == "" {
		return nil, ErrAdmissionInvalid
	}
	if _, err := governedServerBase(cfg.ServerURL, credential.ServerURL); err != nil {
		return nil, err
	}
	owner := Owner{ServerURL: credential.ServerURL, TeamID: credential.TeamID,
		DeviceID: credential.DeviceID, OwnerMemberID: credential.OwnerMemberID}
	bindingOwner := repository.BindingOwner{ServerURL: owner.ServerURL, TeamID: owner.TeamID,
		DeviceID: owner.DeviceID, OwnerMemberID: owner.OwnerMemberID}
	if !validOwner(owner) {
		return nil, ErrAdmissionInvalid
	}
	ownedContext, releaseOwner, err := ownership.AcquireContext(ctx, dataDir)
	if err != nil {
		return nil, err
	}
	resources := &GovernedAdmissionResources{releaseOwner: releaseOwner}
	fail := func(cause error) (*GovernedAdmissionResources, error) {
		return nil, errors.Join(cause, resources.Close())
	}
	preparationRoot, err := ensureGovernedPreparationRoot(dataDir)
	if err != nil {
		return fail(err)
	}
	resources.preparer, err = repository.NewPreparer(preparationRoot, gitExecutable, repository.Limits{})
	if err != nil {
		return fail(err)
	}
	resources.bindings, err = repository.OpenBindingStore(ownedContext, dataDir, bindingOwner,
		gitExecutable, repository.Limits{})
	if err != nil {
		return fail(err)
	}
	resources.profiles, err = OpenProfileStore(ownedContext, dataDir, owner)
	if err != nil {
		return fail(err)
	}
	resources.fence, err = OpenRuntimeFenceStore(ownedContext, dataDir, owner)
	if err != nil {
		return fail(err)
	}
	resources.coordinator, err = NewGovernedAdmissionCoordinator(resources.bindings,
		NewExecutionInputClient(cfg, credential), resources.preparer, resources.profiles, resources.fence,
		NewRuntimeAuthorityClient(cfg, credential), agents)
	if err != nil {
		return fail(err)
	}
	return resources, nil
}

func (r *GovernedAdmissionResources) Coordinator() *GovernedAdmissionCoordinator {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	return r.coordinator
}

func (r *GovernedAdmissionResources) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	r.coordinator = nil
	var result error
	if r.fence != nil {
		result = errors.Join(result, r.fence.Close())
	}
	if r.profiles != nil {
		result = errors.Join(result, r.profiles.Close())
	}
	if r.bindings != nil {
		result = errors.Join(result, r.bindings.Close())
	}
	if r.preparer != nil {
		result = errors.Join(result, r.preparer.Close())
	}
	if r.releaseOwner != nil {
		result = errors.Join(result, r.releaseOwner())
	}
	return result
}

func ensureGovernedPreparationRoot(dataDir string) (string, error) {
	root := filepath.Join(dataDir, governedPreparationDirectory)
	if err := os.Mkdir(root, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", err
	}
	info, err := os.Lstat(root)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return "", ErrAdmissionChanged
	}
	if err := durablefs.SyncParent(root); err != nil {
		return "", err
	}
	return root, nil
}
