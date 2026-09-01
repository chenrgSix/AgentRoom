package admission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/repository"
	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
)

const governedProbeTimeout = 30 * time.Second

// GovernedInputLoader resolves already-authorized exact input bytes. It must
// not invent a missing binding or return content for another Run.
type GovernedInputLoader interface {
	LoadPatches(context.Context, execution.GovernedExecutionManifest) ([]repository.PatchInput, error)
}

type governedBindings interface {
	CheckTaskGrant(context.Context, execution.GovernedExecutionManifest, execution.KindElement, time.Time) error
	ResolveSource(context.Context, string, string, int) (repository.Source, error)
}

type governedPreparer interface {
	Prepare(context.Context, repository.Source, repository.Preparation) (repository.PreparedWorkspace, error)
}

type governedProfiles interface {
	ProbeCodexRuntime(context.Context, CodexRuntimeProbe, time.Time) (RuntimeProfileView, error)
}

type governedFence interface {
	Claim(RuntimeAdmissionSpec, time.Time) (RuntimeAdmissionView, error)
	Get(string) (RuntimeAdmissionView, error)
	Start(context.Context, string, string, RuntimeStartAuthority) (RuntimeAdmissionView, bool, error)
	Stop(string, string, string, RuntimeOutcome, time.Time) (RuntimeAdmissionView, error)
}

type governedAuthority interface {
	Check(context.Context, RuntimeAdmissionSpec) (RuntimeAuthorityView, error)
}

// GovernedAdmissionCoordinator composes every read-only/local prerequisite
// around the one durable possible-start fence. It does not invoke a Runtime,
// advertise a capability, emit Run events or retain a process handle.
type GovernedAdmissionCoordinator struct {
	bindings     governedBindings
	inputs       GovernedInputLoader
	preparer     governedPreparer
	profiles     governedProfiles
	fence        governedFence
	authority    governedAuthority
	agents       map[string]config.AgentConfig
	now          func() time.Time
	probeTimeout time.Duration
}

// GovernedAdmissionTicket keeps transient local paths and input bytes private.
// Its durable authority is only the path-free RuntimeAdmissionView.
type GovernedAdmissionTicket struct {
	request   contracts.RunRequestedPayload
	manifest  execution.GovernedExecutionManifest
	inputs    []repository.PatchInput
	prepared  repository.PreparedWorkspace
	profile   RuntimeProfileView
	admission RuntimeAdmissionView
}

type GovernedStartDecision struct {
	View      RuntimeAdmissionView `json:"view"`
	Invoke    bool                 `json:"invoke"`
	workspace string
}

// Workspace returns a local path only to the sole invoke=true caller. It is
// intentionally absent from JSON and from every durable admission record.
func (d GovernedStartDecision) Workspace() string { return d.workspace }

func NewGovernedAdmissionCoordinator(bindings *repository.BindingStore, inputs GovernedInputLoader,
	preparer *repository.Preparer, profiles *ProfileStore, fence *RuntimeFenceStore,
	authority *RuntimeAuthorityClient, agents map[string]config.AgentConfig) (*GovernedAdmissionCoordinator, error) {
	if bindings == nil || preparer == nil || profiles == nil || fence == nil || authority == nil {
		return nil, ErrAdmissionInvalid
	}
	return newGovernedAdmissionCoordinator(bindings, inputs, preparer, profiles, fence, authority, agents)
}

func newGovernedAdmissionCoordinator(bindings governedBindings, inputs GovernedInputLoader,
	preparer governedPreparer, profiles governedProfiles, fence governedFence,
	authority governedAuthority, agents map[string]config.AgentConfig) (*GovernedAdmissionCoordinator, error) {
	if bindings == nil || inputs == nil || preparer == nil || profiles == nil || fence == nil || authority == nil || len(agents) == 0 {
		return nil, ErrAdmissionInvalid
	}
	cloned := make(map[string]config.AgentConfig, len(agents))
	for id, agent := range agents {
		if !agentID.MatchString(id) {
			return nil, ErrAdmissionInvalid
		}
		agent.Command = append([]string{}, agent.Command...)
		agent.EnvAllowlist = append([]string{}, agent.EnvAllowlist...)
		cloned[id] = agent
	}
	return &GovernedAdmissionCoordinator{bindings: bindings, inputs: inputs, preparer: preparer,
		profiles: profiles, fence: fence, authority: authority, agents: cloned,
		now: time.Now, probeTimeout: governedProbeTimeout}, nil
}

// Prepare validates the delivery and creates/rechecks the exact isolated
// worktree before recording a path-free claim. It creates no start authority.
func (c *GovernedAdmissionCoordinator) Prepare(ctx context.Context, request contracts.RunRequestedPayload) (GovernedAdmissionTicket, error) {
	var empty GovernedAdmissionTicket
	if c == nil || c.now == nil || c.probeTimeout <= 0 {
		return empty, ErrAdmissionInvalid
	}
	frozen, err := cloneGovernedDelivery(request)
	if err != nil {
		return empty, err
	}
	manifest, err := DecodeGovernedManifest(frozen)
	if err != nil {
		return empty, err
	}
	now := c.now().UTC()
	inputs, prepared, profile, spec, err := c.recheckLocal(ctx, manifest, now)
	if err != nil {
		return empty, err
	}
	view, err := c.fence.Claim(spec, now)
	if err != nil {
		return empty, err
	}
	if view.Spec != spec || !sha256Digest.MatchString(view.AdmissionDigest) ||
		(view.State != RuntimeAdmissionClaimed && view.State != RuntimeAdmissionStarting && view.State != RuntimeAdmissionStopped) {
		return empty, ErrAdmissionChanged
	}
	return GovernedAdmissionTicket{request: frozen, manifest: manifest, inputs: inputs,
		prepared: prepared, profile: profile, admission: view}, nil
}

// Start repeats every mutable local check, then observes current authenticated
// Server authority as the final callback step. The fence returns invoke=true at
// most once; this coordinator still does not start the process.
func (c *GovernedAdmissionCoordinator) Start(ctx context.Context, ticket GovernedAdmissionTicket) (GovernedStartDecision, error) {
	var decision GovernedStartDecision
	if c == nil || c.now == nil || !validRuntimeAdmissionSpec(ticket.admission.Spec) || ticket.prepared.Path == "" ||
		ticket.admission.Spec.RunID != ticket.manifest.Scope.RunID ||
		ticket.prepared.RunID != ticket.manifest.Scope.RunID || !sha256Digest.MatchString(ticket.admission.AdmissionDigest) {
		return decision, ErrAdmissionInvalid
	}
	var callbackFailure error
	view, invoke, err := c.fence.Start(ctx, ticket.admission.Spec.RunID, ticket.admission.AdmissionDigest,
		func(checkContext context.Context, expected RuntimeAdmissionSpec) (result error) {
			defer func() { callbackFailure = result }()
			manifest, decodeErr := DecodeGovernedManifest(ticket.request)
			if decodeErr != nil || !reflect.DeepEqual(manifest, ticket.manifest) || expected != ticket.admission.Spec {
				return ErrAdmissionChanged
			}
			inputs, prepared, profile, rebuilt, checkErr := c.recheckLocal(checkContext, manifest, c.now().UTC())
			if checkErr != nil {
				return checkErr
			}
			if !reflect.DeepEqual(inputs, ticket.inputs) || prepared != ticket.prepared ||
				!reflect.DeepEqual(profile, ticket.profile) || rebuilt != expected {
				return ErrAdmissionChanged
			}
			authorityView, checkErr := c.authority.Check(checkContext, expected)
			if checkErr != nil {
				return checkErr
			}
			if !exactRuntimeAuthorityView(expected, authorityView) {
				return ErrAdmissionChanged
			}
			return nil
		})
	if err != nil {
		if callbackFailure != nil {
			return decision, err
		}
		observed, observeErr := c.fence.Get(ticket.admission.Spec.RunID)
		if observeErr == nil && observed.Spec == ticket.admission.Spec &&
			observed.AdmissionDigest == ticket.admission.AdmissionDigest {
			if observed.State == RuntimeAdmissionClaimed {
				return decision, err
			}
			decision.View = observed
			return decision, errors.Join(ErrAdmissionPossibleStart, err)
		}
		return decision, errors.Join(ErrAdmissionPossibleStart, err, observeErr)
	}
	if view.Spec != ticket.admission.Spec || view.AdmissionDigest != ticket.admission.AdmissionDigest {
		return decision, ErrAdmissionChanged
	}
	decision = GovernedStartDecision{View: view, Invoke: invoke}
	if invoke {
		if view.State != RuntimeAdmissionStarting || view.StartDigest == nil {
			return GovernedStartDecision{}, ErrAdmissionChanged
		}
		decision.workspace = ticket.prepared.Path
	}
	return decision, nil
}

// Stop closes only the exact invoke=true possible-start decision. It records a
// local process outcome, not verification, Result acceptance or Task completion.
func (c *GovernedAdmissionCoordinator) Stop(ticket GovernedAdmissionTicket, decision GovernedStartDecision,
	outcome RuntimeOutcome, now time.Time) (RuntimeAdmissionView, error) {
	if c == nil || c.fence == nil || !decision.Invoke || decision.workspace == "" ||
		decision.workspace != ticket.prepared.Path || decision.View.Spec != ticket.admission.Spec ||
		decision.View.AdmissionDigest != ticket.admission.AdmissionDigest ||
		decision.View.State != RuntimeAdmissionStarting || decision.View.StartDigest == nil ||
		!validRuntimeOutcome(outcome) || now.IsZero() {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	view, err := c.fence.Stop(ticket.admission.Spec.RunID, ticket.admission.AdmissionDigest,
		*decision.View.StartDigest, outcome, now.UTC())
	if err != nil {
		return RuntimeAdmissionView{}, err
	}
	if view.Spec != ticket.admission.Spec || view.AdmissionDigest != ticket.admission.AdmissionDigest ||
		view.State != RuntimeAdmissionStopped || view.StartDigest == nil ||
		*view.StartDigest != *decision.View.StartDigest || view.Outcome == nil || *view.Outcome != outcome {
		return RuntimeAdmissionView{}, ErrAdmissionChanged
	}
	return view, nil
}

func (c *GovernedAdmissionCoordinator) recheckLocal(ctx context.Context, manifest execution.GovernedExecutionManifest,
	now time.Time) ([]repository.PatchInput, repository.PreparedWorkspace, RuntimeProfileView, RuntimeAdmissionSpec, error) {
	if err := ctx.Err(); err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	if now.IsZero() {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, ErrAdmissionInvalid
	}
	if len(manifest.VerificationProfiles) != 0 {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, ErrProfileUnsupported
	}
	agent, ok := c.agents[manifest.Scope.AgentID]
	if !ok {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, ErrProfileDenied
	}
	if err := c.bindings.CheckTaskGrant(ctx, manifest, execution.Prepare, now); err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	inputs, err := c.inputs.LoadPatches(ctx, manifest)
	if err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	inputs, err = exactManifestPatches(manifest, inputs)
	if err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	source, err := c.bindings.ResolveSource(ctx, manifest.Repository.BindingID, manifest.Repository.RepositoryID, 1)
	if err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	prepared, err := c.preparer.Prepare(ctx, source, repository.Preparation{OperationID: "op_prepare_" + manifest.ManifestDigest,
		RunID: manifest.Scope.RunID, RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
		WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
		ManifestDigest: manifest.ManifestDigest, BaseCommit: manifest.Repository.BaseCommit, Inputs: inputs,
		ScopePolicy: execution.ManifestScopePolicy(manifest.ScopePolicy)})
	if err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	reference := execution.ExecutionGrantSummaryRuntimeProfile{ProfileID: manifest.Repository.RuntimeProfileID,
		Revision: 1, Digest: manifest.Repository.RuntimeProfileDigest}
	profile, err := c.profiles.ProbeCodexRuntime(ctx, CodexRuntimeProbe{Reference: reference,
		AgentID: manifest.Scope.AgentID, Agent: agent, Workspace: prepared.Path, Timeout: c.probeTimeout}, now)
	if err != nil {
		return nil, repository.PreparedWorkspace{}, RuntimeProfileView{}, RuntimeAdmissionSpec{}, err
	}
	spec, err := NewRuntimeAdmissionSpec(manifest, prepared, profile)
	return inputs, prepared, profile, spec, err
}

func exactManifestPatches(manifest execution.GovernedExecutionManifest, inputs []repository.PatchInput) ([]repository.PatchInput, error) {
	if len(inputs) != len(manifest.Inputs) {
		return nil, ErrAdmissionInvalid
	}
	frozen := make([]repository.PatchInput, len(inputs))
	for index, input := range inputs {
		binding := manifest.Inputs[index]
		hash := sha256.Sum256(input.Bytes)
		if binding.Artifact.Kind != execution.Patch || input.BindingID != binding.BindingID ||
			input.SHA256 != binding.Artifact.ContentDigest || input.SHA256 != hex.EncodeToString(hash[:]) ||
			int64(len(input.Bytes)) != binding.Artifact.ByteLength || len(input.Bytes) == 0 {
			return nil, ErrAdmissionInvalid
		}
		frozen[index] = input
		frozen[index].Bytes = append([]byte{}, input.Bytes...)
	}
	return frozen, nil
}

func exactRuntimeAuthorityView(spec RuntimeAdmissionSpec, view RuntimeAuthorityView) bool {
	checkedAt, err := time.Parse(time.RFC3339Nano, view.CheckedAt)
	return err == nil && view.Version == 1 && view.RunID == spec.RunID && view.LeaseID == spec.LeaseID &&
		view.ManifestDigest == spec.ManifestDigest && view.WorkspaceRef == spec.WorkspaceRef &&
		view.WorkspaceGeneration == spec.WorkspaceGeneration && view.State == "active" && view.LeaseRevision == 1 &&
		view.ExpiresAt == spec.WorkspaceExpiresAt && runtimeAdmissionCurrent(spec, checkedAt)
}

func cloneGovernedDelivery(request contracts.RunRequestedPayload) (contracts.RunRequestedPayload, error) {
	var cloned contracts.RunRequestedPayload
	raw, err := json.Marshal(request)
	if err != nil {
		return cloned, ErrAdmissionInvalid
	}
	if err := json.Unmarshal(raw, &cloned); err != nil {
		return cloned, ErrAdmissionInvalid
	}
	return cloned, nil
}
