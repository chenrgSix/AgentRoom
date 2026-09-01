package admission

import (
	"context"
	"errors"
	"reflect"
	"time"

	"convenewire.dev/bridge/internal/config"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
)

type governedAdapterFactory func(config.AgentConfig, bridgeruntime.RuntimeSessionStore) bridgeruntime.Adapter

var ErrRuntimeOutcomeMissing = errors.New("governed Runtime returned without a terminal outcome")

// GovernedRuntimeRunner is the sole consumer of an invoke=true decision. It
// runs one exact Codex adapter in the prepared workspace and closes the local
// possible-start fence from the observed terminal process outcome.
type GovernedRuntimeRunner struct {
	coordinator *GovernedAdmissionCoordinator
	agents      map[string]config.AgentConfig
	sessions    bridgeruntime.RuntimeSessionStore
	newAdapter  governedAdapterFactory
	now         func() time.Time
}

func NewGovernedRuntimeRunner(coordinator *GovernedAdmissionCoordinator, agents map[string]config.AgentConfig,
	sessions bridgeruntime.RuntimeSessionStore) (*GovernedRuntimeRunner, error) {
	return newGovernedRuntimeRunner(coordinator, agents, sessions,
		func(agent config.AgentConfig, store bridgeruntime.RuntimeSessionStore) bridgeruntime.Adapter {
			return bridgeruntime.CodexAdapter{Config: agent, Sessions: store}
		})
}

func newGovernedRuntimeRunner(coordinator *GovernedAdmissionCoordinator, agents map[string]config.AgentConfig,
	sessions bridgeruntime.RuntimeSessionStore, factory governedAdapterFactory) (*GovernedRuntimeRunner, error) {
	if coordinator == nil || len(agents) == 0 || factory == nil {
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
	return &GovernedRuntimeRunner{coordinator: coordinator, agents: cloned, sessions: sessions,
		newAdapter: factory, now: time.Now}, nil
}

func (r *GovernedRuntimeRunner) Run(ctx context.Context, ticket GovernedAdmissionTicket,
	decision GovernedStartDecision, emit bridgeruntime.EmitFunc) (RuntimeAdmissionView, error) {
	if r == nil || r.coordinator == nil || r.newAdapter == nil || r.now == nil || emit == nil ||
		!decision.Invoke || decision.workspace == "" || decision.workspace != ticket.prepared.Path ||
		decision.View.Spec != ticket.admission.Spec || decision.View.AdmissionDigest != ticket.admission.AdmissionDigest ||
		decision.View.State != RuntimeAdmissionStarting || decision.View.StartDigest == nil {
		return RuntimeAdmissionView{}, ErrAdmissionInvalid
	}
	manifest, err := DecodeGovernedManifest(ticket.request)
	if err != nil || !reflect.DeepEqual(manifest, ticket.manifest) {
		return r.stopUnknown(ticket, decision, ErrAdmissionChanged)
	}
	agent, ok := r.agents[manifest.Scope.AgentID]
	if !ok || agent.RuntimeKind != CodexRuntimeKind || agent.Adapter != CodexRuntimeKind {
		return r.stopUnknown(ticket, decision, ErrProfileDenied)
	}
	agent.Workspace = decision.workspace
	adapter := r.newAdapter(agent, r.sessions)
	if adapter == nil || adapter.Name() != CodexRuntimeKind {
		return r.stopUnknown(ticket, decision, ErrProfileDenied)
	}
	outcome := RuntimeOutcomeUnknown
	terminal := false
	var emittedErr error
	executeErr := adapter.Execute(ctx, bridgeruntime.Request{Run: ticket.request},
		func(eventContext context.Context, event bridgeruntime.Event) error {
			if terminal {
				emittedErr = ErrAdmissionChanged
				return emittedErr
			}
			if event.Status != nil {
				if resolved, ok := runtimeOutcomeForStatus(*event.Status); ok {
					outcome, terminal = resolved, true
				}
			}
			if err := emit(eventContext, event); err != nil {
				emittedErr = err
				return err
			}
			return nil
		})
	if emittedErr != nil && executeErr == nil {
		executeErr = emittedErr
	}
	if !terminal && executeErr == nil {
		executeErr = ErrRuntimeOutcomeMissing
	}
	view, stopErr := r.coordinator.Stop(ticket, decision, outcome, r.now().UTC())
	return view, errors.Join(executeErr, stopErr)
}

func (r *GovernedRuntimeRunner) stopUnknown(ticket GovernedAdmissionTicket,
	decision GovernedStartDecision, cause error) (RuntimeAdmissionView, error) {
	view, stopErr := r.coordinator.Stop(ticket, decision, RuntimeOutcomeUnknown, r.now().UTC())
	return view, errors.Join(cause, stopErr)
}

func runtimeOutcomeForStatus(status contracts.RunExecutionStatus) (RuntimeOutcome, bool) {
	switch status {
	case contracts.Completed:
		return RuntimeOutcomeCompleted, true
	case contracts.Failed:
		return RuntimeOutcomeFailed, true
	case contracts.Canceled:
		return RuntimeOutcomeCanceled, true
	case contracts.InputRequired:
		return RuntimeOutcomeInputRequired, true
	case contracts.OutcomeUnknown:
		return RuntimeOutcomeUnknown, true
	default:
		return "", false
	}
}
