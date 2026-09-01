package admission

import (
	"context"
	"errors"
	"reflect"
	"time"

	"convenewire.dev/bridge/internal/config"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type governedAdapterFactory func(config.AgentConfig, bridgeruntime.RuntimeSessionStore,
	bridgeruntime.GovernedProcessTracker, bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter

type governedCapture interface {
	CaptureCompleted(context.Context, GovernedAdmissionTicket, GovernedStartDecision) (execution.RepositoryCheckpoint, error)
}

var ErrRuntimeOutcomeMissing = errors.New("governed Runtime returned without a terminal outcome")

// GovernedRuntimeRunner is the sole consumer of an invoke=true decision. It
// runs one exact Codex adapter in the prepared workspace and closes the local
// possible-start fence from the observed terminal process outcome.
type GovernedRuntimeRunner struct {
	coordinator *GovernedAdmissionCoordinator
	agents      map[string]config.AgentConfig
	sessions    bridgeruntime.RuntimeSessionStore
	processes   bridgeruntime.GovernedProcessTracker
	capture     governedCapture
	newAdapter  governedAdapterFactory
	now         func() time.Time
}

func NewGovernedRuntimeRunner(coordinator *GovernedAdmissionCoordinator, agents map[string]config.AgentConfig,
	sessions bridgeruntime.RuntimeSessionStore,
	processes bridgeruntime.GovernedProcessTracker, capture *GovernedCaptureCoordinator) (*GovernedRuntimeRunner, error) {
	return newGovernedRuntimeRunner(coordinator, agents, sessions, processes, capture,
		func(agent config.AgentConfig, store bridgeruntime.RuntimeSessionStore,
			tracker bridgeruntime.GovernedProcessTracker,
			identity bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
			return bridgeruntime.CodexAdapter{Config: agent, Sessions: store,
				ProcessTracker: tracker, ProcessIdentity: identity}
		})
}

func newGovernedRuntimeRunner(coordinator *GovernedAdmissionCoordinator, agents map[string]config.AgentConfig,
	sessions bridgeruntime.RuntimeSessionStore, processes bridgeruntime.GovernedProcessTracker,
	capture governedCapture, factory governedAdapterFactory) (*GovernedRuntimeRunner, error) {
	if coordinator == nil || len(agents) == 0 || processes == nil || capture == nil || factory == nil {
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
	return &GovernedRuntimeRunner{coordinator: coordinator, agents: cloned, sessions: sessions, processes: processes,
		capture: capture, newAdapter: factory, now: time.Now}, nil
}

func (r *GovernedRuntimeRunner) Run(ctx context.Context, ticket GovernedAdmissionTicket,
	decision GovernedStartDecision, emit bridgeruntime.EmitFunc) (RuntimeAdmissionView, error) {
	if r == nil || r.coordinator == nil || r.capture == nil || r.newAdapter == nil || r.now == nil || emit == nil ||
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
	processIdentity := bridgeruntime.GovernedProcessIdentity{RunID: decision.View.Spec.RunID,
		AdmissionDigest: decision.View.AdmissionDigest, StartDigest: *decision.View.StartDigest}
	if bridgeruntime.ValidateGovernedProcessIdentity(processIdentity) != nil {
		return r.stopUnknown(ticket, decision, ErrAdmissionChanged)
	}
	adapter := r.newAdapter(agent, r.sessions, r.processes, processIdentity)
	if adapter == nil || adapter.Name() != CodexRuntimeKind {
		return r.stopUnknown(ticket, decision, ErrProfileDenied)
	}
	outcome := RuntimeOutcomeUnknown
	terminal := false
	var terminalEvent bridgeruntime.Event
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
					terminalEvent = event
					return nil
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
	if terminal && executeErr == nil && outcome == RuntimeOutcomeCompleted {
		if _, captureErr := r.capture.CaptureCompleted(ctx, ticket, decision); captureErr != nil {
			terminalEvent = captureOutcomeUnknownEvent(terminalEvent)
		}
	}
	view, stopErr := r.coordinator.Stop(ticket, decision, outcome, r.now().UTC())
	if executeErr != nil || stopErr != nil || !terminal {
		return view, errors.Join(executeErr, stopErr)
	}
	return view, emit(ctx, terminalEvent)
}

func captureOutcomeUnknownEvent(event bridgeruntime.Event) bridgeruntime.Event {
	status := contracts.OutcomeUnknown
	event.Status = &status
	event.Clarification = nil
	event.Error = &contracts.ConveneWireError{Code: "GOVERNED_CAPTURE_OUTCOME_UNKNOWN",
		Message: "Governed repository output could not be confirmed as a canonical checkpoint.", Retryable: false}
	return event
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
