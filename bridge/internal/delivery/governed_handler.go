package delivery

import (
	"context"
	"errors"
	"time"

	"convenewire.dev/bridge/internal/admission"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
)

var ErrGovernedRuntimeAmbiguous = errors.New("governed Runtime has an unresolved possible-start state")

type GovernedAdmission interface {
	Prepare(context.Context, contracts.RunRequestedPayload) (admission.GovernedAdmissionTicket, error)
	Start(context.Context, admission.GovernedAdmissionTicket) (admission.GovernedStartDecision, error)
}

type GovernedRunner interface {
	Run(context.Context, admission.GovernedAdmissionTicket, admission.GovernedStartDecision,
		bridgeruntime.EmitFunc) (admission.RuntimeAdmissionView, error)
}

// GovernedHandler uses the existing Inbox, execution gate, Runtime event
// persistence and terminal replay. Its only Runtime adapter is backed by the
// admission runner's sole invoke=true decision.
type GovernedHandler struct {
	Inbox                *Inbox
	Gate                 *AgentExecutionGate
	Admission            GovernedAdmission
	Runner               GovernedRunner
	Executor             *RuntimeExecutor
	AllowsAgent          func(string) bool
	IsExplicitCancel     func(context.Context) bool
	IsRetryableAdmission func(error) bool
	Now                  func() time.Time
}

func (h *GovernedHandler) Handle(ctx context.Context, message contracts.RunRequestedMessage, send Sender) error {
	if h == nil || h.Inbox == nil || h.Admission == nil || h.Runner == nil || h.Executor == nil ||
		h.Executor.Inbox != h.Inbox || send == nil || message.Payload.ContextManifest == nil ||
		message.Payload.ContextManifest.Execution == nil || h.AllowsAgent == nil ||
		!h.AllowsAgent(message.Payload.TargetAgentID) {
		return ErrGovernedExecutionUnsupported
	}
	now := h.now()
	record, duplicate, err := h.Inbox.Accept(message.Payload, now)
	if err != nil {
		return err
	}
	base := Handler{Inbox: h.Inbox, OnQueuedCanceled: h.Executor.CancelQueued,
		IsExplicitCancel: h.IsExplicitCancel, Now: h.Now}
	canceled, err := h.Inbox.HasCancellation(record.Request)
	if err != nil {
		return err
	}
	if canceled {
		return base.cancelBeforeAdmission(ctx, record, send, now)
	}
	if duplicate && isTerminalState(record.State) {
		if err := send(ctx, governedAccepted(record, now)); err != nil {
			return err
		}
		return h.Executor.Replay(ctx, record, send)
	}
	if duplicate && record.State == StateWorking {
		return ErrGovernedRuntimeAmbiguous
	}
	if record.State == StateAccepted {
		record, err = h.Inbox.TransitionLocalState(record.RunID, StateAccepted, StatePreparing, now)
		if err != nil {
			return err
		}
	} else if record.State != StatePreparing {
		return ErrGovernedRuntimeAmbiguous
	}
	ticket, prepareErr := h.Admission.Prepare(ctx, record.Request)
	if prepareErr != nil {
		if h.isExplicitCancel(ctx) {
			return base.cancelDuringPreparation(ctx, record, send, now)
		}
		if h.retryable(prepareErr) {
			return prepareErr
		}
		record, err = h.Inbox.TransitionLocalState(record.RunID, StatePreparing, StateAccepted, h.now())
		if err != nil {
			return err
		}
		return h.failBeforeAcceptance(ctx, record, send, now)
	}
	record, err = h.Inbox.TransitionLocalState(record.RunID, StatePreparing, StateAccepted, h.now())
	if err != nil {
		return err
	}
	canceled, err = h.Inbox.HasCancellation(record.Request)
	if err != nil {
		return err
	}
	if canceled || h.isExplicitCancel(ctx) {
		return base.cancelBeforeAdmission(ctx, record, send, now)
	}
	if err := send(ctx, governedAccepted(record, now)); err != nil {
		return err
	}
	if h.Gate != nil {
		release, err := h.Gate.Acquire(ctx, record.Request.TargetAgentID)
		if err != nil {
			return base.handleQueueExit(ctx, record, send)
		}
		defer release()
		canceled, err = h.Inbox.HasCancellation(record.Request)
		if err != nil {
			return err
		}
		if canceled || h.isExplicitCancel(ctx) {
			return base.cancelAfterAcceptance(ctx, record, send)
		}
	}
	decision, startErr := h.Admission.Start(ctx, ticket)
	if startErr != nil {
		if errors.Is(startErr, admission.ErrAdmissionPossibleStart) {
			return ErrGovernedRuntimeAmbiguous
		}
		if h.isExplicitCancel(ctx) {
			return base.cancelAfterAcceptance(ctx, record, send)
		}
		if h.retryable(startErr) {
			return startErr
		}
		return h.Executor.failBeforeRuntime(ctx, record, send, "GOVERNED_ADMISSION_DENIED",
			"Current governed Runtime authority could not be established.")
	}
	if !decision.Invoke {
		latest, err := h.Inbox.Get(record.RunID)
		if err != nil {
			return err
		}
		if isTerminalState(latest.State) {
			return h.Executor.Replay(ctx, latest, send)
		}
		return ErrGovernedRuntimeAmbiguous
	}
	adapter := &governedAdmittedAdapter{runner: h.Runner, ticket: ticket, decision: decision}
	return h.Executor.ExecuteAdmitted(ctx, record, adapter, send)
}

func (h *GovernedHandler) failBeforeAcceptance(ctx context.Context, record Record, send Sender, now time.Time) error {
	var terminal []any
	if err := h.Executor.failBeforeRuntime(ctx, record, func(_ context.Context, value any) error {
		terminal = append(terminal, value)
		return nil
	}, "GOVERNED_ADMISSION_DENIED", "Local governed Runtime admission failed closed."); err != nil {
		return err
	}
	if err := send(ctx, governedAccepted(record, now)); err != nil {
		return err
	}
	for _, value := range terminal {
		if err := send(ctx, value); err != nil {
			return err
		}
	}
	return nil
}

func (h *GovernedHandler) retryable(err error) bool {
	if h.IsRetryableAdmission != nil {
		return h.IsRetryableAdmission(err)
	}
	return errors.Is(err, admission.ErrInputUnavailable) || errors.Is(err, admission.ErrAuthorityUnavailable)
}

func (h *GovernedHandler) isExplicitCancel(ctx context.Context) bool {
	return h.IsExplicitCancel != nil && h.IsExplicitCancel(ctx)
}

func (h *GovernedHandler) now() time.Time {
	if h.Now != nil {
		return h.Now().UTC()
	}
	return time.Now().UTC()
}

func governedAccepted(record Record, now time.Time) contracts.RunAcceptedMessage {
	return contracts.RunAcceptedMessage{ProtocolVersion: "1.0", MessageID: newMessageID(), Timestamp: now.UTC(),
		Type: contracts.RunAccepted, Payload: contracts.RunAcceptedPayload{AgentID: record.Request.TargetAgentID,
			RunID: record.RunID, TraceID: record.Request.TraceID, Sequence: 1}}
}

type governedAdmittedAdapter struct {
	runner   GovernedRunner
	ticket   admission.GovernedAdmissionTicket
	decision admission.GovernedStartDecision
}

func (*governedAdmittedAdapter) Name() string { return "codex" }
func (*governedAdmittedAdapter) Capabilities() bridgeruntime.Capabilities {
	return bridgeruntime.Capabilities{SupportsInterrupt: true, SupportsStreaming: true}
}
func (a *governedAdmittedAdapter) Execute(ctx context.Context, _ bridgeruntime.Request,
	emit bridgeruntime.EmitFunc) error {
	_, err := a.runner.Run(ctx, a.ticket, a.decision, emit)
	return err
}
