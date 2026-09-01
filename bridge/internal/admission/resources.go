package admission

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
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
	processes    *GovernedProcessStore
	agents       map[string]config.AgentConfig
	releaseOwner func() error
	closed       bool
}

func OpenGovernedAdmissionResources(ctx context.Context, cfg config.Config, credential pairing.Credential,
	gitExecutable string, agents map[string]config.AgentConfig) (*GovernedAdmissionResources, error) {
	dataDir, err := governedDataDirectory(cfg.DataDir)
	if err != nil {
		return nil, err
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
	clonedAgents := make(map[string]config.AgentConfig, len(agents))
	for agentID, agent := range agents {
		agent.Command = append([]string{}, agent.Command...)
		agent.EnvAllowlist = append([]string{}, agent.EnvAllowlist...)
		clonedAgents[agentID] = agent
	}
	resources := &GovernedAdmissionResources{releaseOwner: releaseOwner, agents: clonedAgents}
	fail := func(cause error) (*GovernedAdmissionResources, error) {
		return nil, errors.Join(cause, resources.Close())
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
	resources.processes, err = OpenGovernedProcessStore(ownedContext, dataDir, owner)
	if err != nil {
		return fail(err)
	}
	// Recovery must remain available even when Git is temporarily absent. A
	// missing executable disables new preparation instead of bypassing the
	// process/admission journals that may still contain a possible start.
	if gitExecutable != "" && len(clonedAgents) != 0 {
		preparationRoot, prepareErr := ensureGovernedPreparationRoot(dataDir)
		if prepareErr != nil {
			return fail(prepareErr)
		}
		resources.preparer, err = repository.NewPreparer(preparationRoot, gitExecutable, repository.Limits{})
		if err != nil {
			return fail(err)
		}
		resources.coordinator, err = NewGovernedAdmissionCoordinator(resources.bindings,
			NewExecutionInputClient(cfg, credential), resources.preparer, resources.profiles, resources.fence,
			NewRuntimeAuthorityClient(cfg, credential), clonedAgents)
		if err != nil {
			return fail(err)
		}
	}
	return resources, nil
}

// governedDataDirectory keeps the configured leaf non-symlinked while
// canonicalizing platform parent aliases such as macOS /var -> /private/var.
// Every store and the process-owner lock then operate on the same physical
// directory identity.
func governedDataDirectory(path string) (string, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", ErrAdmissionInvalid
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return "", ErrAdmissionInvalid
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", ErrAdmissionInvalid
	}
	canonical, err := canonicalPrivateDirectory(resolved)
	if err != nil {
		return "", ErrAdmissionInvalid
	}
	return canonical, nil
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

func (r *GovernedAdmissionResources) RecoveryFence() *RuntimeRecoveryFence {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.fence == nil {
		return nil
	}
	return &RuntimeRecoveryFence{store: r.fence}
}

func (r *GovernedAdmissionResources) ProcessTracker() bridgeruntime.GovernedProcessTracker {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.processes == nil {
		return nil
	}
	return &RuntimeProcessTracker{store: r.processes}
}

func (r *GovernedAdmissionResources) ProcessFencer() *RuntimeProcessFencer {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.processes == nil {
		return nil
	}
	return &RuntimeProcessFencer{store: r.processes}
}

// ReadyAgentIDs returns only Agents with one current owner-local chain that the
// present implementation can actually prepare: exact configured Codex Runtime,
// positive unrevoked profile, current Task grant, current repository binding
// and unchanged physical Git source. It publishes no local identity or path.
//
// This is capability readiness, not Run authority. Admission still checks the
// exact manifest/grant and reruns the physical Runtime probe immediately before
// the sole possible start.
func (r *GovernedAdmissionResources) ReadyAgentIDs(ctx context.Context, now time.Time) (map[string]bool, error) {
	ready := map[string]bool{}
	if r == nil || now.IsZero() {
		return nil, ErrAdmissionInvalid
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.bindings == nil || r.profiles == nil {
		return nil, ErrAdmissionInvalid
	}
	// Validate complete inventories before selecting a usable subset. Corrupt
	// unrelated owner state must not be hidden by an otherwise valid grant.
	if _, err := r.bindings.List(); err != nil {
		return nil, err
	}
	grants, err := r.bindings.ListTaskGrants()
	if err != nil {
		return nil, err
	}
	if _, err := r.profiles.List(); err != nil {
		return nil, err
	}
	if r.coordinator == nil || r.preparer == nil {
		return ready, nil
	}
	for _, grant := range grants {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		issuedAt, issuedErr := time.Parse(time.RFC3339Nano, grant.Summary.IssuedAt)
		expiresAt, expiresErr := time.Parse(time.RFC3339Nano, grant.Summary.Grant.ExpiresAt)
		agent, configured := r.agents[grant.Spec.AgentID]
		if issuedErr != nil || expiresErr != nil || now.Before(issuedAt) || !now.Before(expiresAt) ||
			grant.Summary.RevokedAt != nil || grant.Summary.Grant.Revision != 1 || !configured ||
			!slices.Contains(grant.Spec.Operations, execution.Prepare) || len(grant.Spec.VerificationProfiles) != 0 ||
			grant.Spec.ScopePolicy.RequirePreventivePathEnforcement {
			continue
		}
		if _, err := r.profiles.ResolveRuntime(grant.Spec.RuntimeProfile, grant.Spec.AgentID, agent); err != nil {
			continue
		}
		if _, err := r.bindings.ResolveSource(ctx, grant.Spec.BindingID, grant.Spec.RepositoryID,
			grant.Spec.BindingRevision); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		ready[grant.Spec.AgentID] = true
	}
	return ready, nil
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
	r.agents = nil
	var result error
	if r.processes != nil {
		result = errors.Join(result, r.processes.Close())
	}
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
