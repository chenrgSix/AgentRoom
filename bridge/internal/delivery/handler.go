package delivery

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
)

type Sender func(context.Context, any) error
type NewRunFunc func(context.Context, Record, Sender) error
type PrepareRunFunc func(
	context.Context,
	contracts.RunRequestedPayload,
) ([]contracts.VerifiedArtifactMaterializationReceipt, error)
type PreparationFailedFunc func(context.Context, Record, Sender, error) error

// No current Bridge advertises governed execution. This prerequisite must be
// replaced by actual local grant/preparation admission, never a silent fallback.
var ErrGovernedExecutionUnsupported = errors.New("governed execution requires a supported local admission implementation")

type Handler struct {
	Inbox              *Inbox
	Gate               *AgentExecutionGate
	OnNew              NewRunFunc
	OnDuplicate        NewRunFunc
	OnQueuedCanceled   NewRunFunc
	Prepare            PrepareRunFunc
	OnPrepareFailed    PreparationFailedFunc
	IsPrepareRetryable func(error) bool
	IsExplicitCancel   func(context.Context) bool
	Now                func() time.Time
}

func (h Handler) Handle(ctx context.Context, message contracts.RunRequestedMessage, send Sender) error {
	if message.Payload.ContextManifest != nil && message.Payload.ContextManifest.Execution != nil {
		return ErrGovernedExecutionUnsupported
	}
	now := time.Now().UTC()
	if h.Now != nil {
		now = h.Now().UTC()
	}
	record, duplicate, err := h.Inbox.Accept(message.Payload, now)
	if err != nil {
		return err
	}
	canceledBeforeAdmission, err := h.Inbox.HasCancellation(record.Request)
	if err != nil {
		return err
	}
	if canceledBeforeAdmission {
		return h.cancelBeforeAdmission(ctx, record, send, now)
	}
	resumePreparing := duplicate && record.State == StatePreparing
	var materializations []contracts.VerifiedArtifactMaterializationReceipt
	var prepareErr error
	if h.Prepare != nil {
		if !duplicate {
			record, err = h.Inbox.TransitionLocalState(
				record.RunID,
				StateAccepted,
				StatePreparing,
				now,
			)
			if err != nil {
				return err
			}
		}
		materializations, prepareErr = h.Prepare(ctx, record.Request)
		if prepareErr != nil && h.IsPrepareRetryable != nil &&
			h.IsPrepareRetryable(prepareErr) {
			if h.IsExplicitCancel != nil && h.IsExplicitCancel(ctx) {
				return h.cancelDuringPreparation(ctx, record, send, now)
			}
			return prepareErr
		}
		if record.State == StatePreparing {
			record, err = h.Inbox.TransitionLocalState(
				record.RunID,
				StatePreparing,
				StateAccepted,
				now,
			)
			if err != nil {
				return err
			}
		}
	}
	canceledBeforeAcceptance, err := h.Inbox.HasCancellation(record.Request)
	if err != nil {
		return err
	}
	if canceledBeforeAcceptance || h.isExplicitCancel(ctx) {
		return h.cancelBeforeAdmission(ctx, record, send, now)
	}
	accepted := contracts.RunAcceptedMessage{
		ProtocolVersion: "1.0",
		MessageID:       newMessageID(),
		Timestamp:       now,
		Type:            contracts.RunAccepted,
		Payload: contracts.RunAcceptedPayload{
			AgentID:                  message.Payload.TargetAgentID,
			RunID:                    message.Payload.RunID,
			TraceID:                  message.Payload.TraceID,
			Sequence:                 1,
			ArtifactMaterializations: materializations,
		},
	}
	if prepareErr != nil {
		accepted.Payload.ArtifactMaterializationError = materializationFailureAcknowledgement()
		if h.OnPrepareFailed == nil {
			return prepareErr
		}
		var terminal []any
		if err := h.OnPrepareFailed(
			ctx,
			record,
			func(_ context.Context, value any) error {
				terminal = append(terminal, value)
				return nil
			},
			prepareErr,
		); err != nil {
			return err
		}
		if err := send(ctx, accepted); err != nil {
			return err
		}
		for _, value := range terminal {
			if err := send(ctx, value); err != nil {
				return err
			}
		}
		return nil
	}
	if err := send(ctx, accepted); err != nil {
		return err
	}
	if duplicate && h.OnDuplicate != nil {
		if resumePreparing && h.OnNew != nil {
			return h.runNew(ctx, message, record, send)
		}
		return h.OnDuplicate(ctx, record, send)
	}
	if !duplicate && h.OnNew != nil {
		return h.runNew(ctx, message, record, send)
	}
	return nil
}

func materializationFailureAcknowledgement() *contracts.ArtifactMaterializationError {
	return &contracts.ArtifactMaterializationError{
		Code:      "ARTIFACT_MATERIALIZATION_FAILED",
		Message:   "Pinned Artifact content could not be verified in isolated staging.",
		Retryable: false,
	}
}

func (h Handler) runNew(
	ctx context.Context,
	message contracts.RunRequestedMessage,
	record Record,
	send Sender,
) error {
	canceled, err := h.Inbox.HasCancellation(record.Request)
	if err != nil {
		return err
	}
	if canceled || h.isExplicitCancel(ctx) {
		return h.cancelAfterAcceptance(ctx, record, send)
	}
	if h.Gate != nil {
		release, err := h.Gate.Acquire(ctx, message.Payload.TargetAgentID)
		if err != nil {
			return h.handleQueueExit(ctx, record, send)
		}
		defer release()
		canceled, err = h.Inbox.HasCancellation(record.Request)
		if err != nil {
			return err
		}
		if canceled || h.isExplicitCancel(ctx) {
			return h.cancelAfterAcceptance(ctx, record, send)
		}
	}
	return h.OnNew(ctx, record, send)
}

func (h Handler) isExplicitCancel(ctx context.Context) bool {
	return h.IsExplicitCancel != nil && h.IsExplicitCancel(ctx)
}

func (h Handler) cancelAfterAcceptance(
	ctx context.Context,
	record Record,
	send Sender,
) error {
	if h.OnQueuedCanceled == nil {
		return errors.New("queued cancellation handler is unavailable")
	}
	reportContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := h.OnQueuedCanceled(reportContext, record, send); err != nil {
		return err
	}
	return h.Inbox.ClearCancellation(record.RunID)
}

func (h Handler) cancelBeforeAdmission(
	ctx context.Context,
	record Record,
	send Sender,
	now time.Time,
) error {
	if record.State == StatePreparing {
		var err error
		record, err = h.Inbox.TransitionLocalState(
			record.RunID,
			StatePreparing,
			StateAccepted,
			now,
		)
		if err != nil {
			return err
		}
	}
	reportContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var terminal []any
	if h.OnQueuedCanceled == nil {
		return errors.New("queued cancellation handler is unavailable")
	}
	if err := h.OnQueuedCanceled(
		reportContext,
		record,
		func(_ context.Context, value any) error {
			terminal = append(terminal, value)
			return nil
		},
	); err != nil {
		return err
	}
	accepted := contracts.RunAcceptedMessage{
		ProtocolVersion: "1.0", MessageID: newMessageID(), Timestamp: now,
		Type: contracts.RunAccepted,
		Payload: contracts.RunAcceptedPayload{
			AgentID: record.Request.TargetAgentID, RunID: record.RunID,
			TraceID: record.Request.TraceID, Sequence: 1,
		},
	}
	if runHasPinnedArtifactContent(record.Request) {
		accepted.Payload.ArtifactMaterializationError = materializationFailureAcknowledgement()
	}
	if err := send(reportContext, accepted); err != nil {
		return err
	}
	for _, value := range terminal {
		if err := send(reportContext, value); err != nil {
			return err
		}
	}
	return h.Inbox.ClearCancellation(record.RunID)
}

func (h Handler) cancelDuringPreparation(
	ctx context.Context,
	record Record,
	send Sender,
	now time.Time,
) error {
	if record.State == StatePreparing {
		var err error
		record, err = h.Inbox.TransitionLocalState(
			record.RunID,
			StatePreparing,
			StateAccepted,
			now,
		)
		if err != nil {
			return err
		}
	}
	reportContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var terminal []any
	if h.OnQueuedCanceled != nil {
		if err := h.OnQueuedCanceled(
			reportContext,
			record,
			func(_ context.Context, value any) error {
				terminal = append(terminal, value)
				return nil
			},
		); err != nil {
			return err
		}
	}
	accepted := contracts.RunAcceptedMessage{
		ProtocolVersion: "1.0", MessageID: newMessageID(), Timestamp: now,
		Type: contracts.RunAccepted,
		Payload: contracts.RunAcceptedPayload{
			AgentID: record.Request.TargetAgentID, RunID: record.RunID,
			TraceID: record.Request.TraceID, Sequence: 1,
			ArtifactMaterializationError: materializationFailureAcknowledgement(),
		},
	}
	if err := send(reportContext, accepted); err != nil {
		return err
	}
	for _, value := range terminal {
		if err := send(reportContext, value); err != nil {
			return err
		}
	}
	return h.Inbox.ClearCancellation(record.RunID)
}

func (h Handler) handleQueueExit(ctx context.Context, record Record, send Sender) error {
	if !h.isExplicitCancel(ctx) || h.OnQueuedCanceled == nil {
		// The durable accepted record remains recoverable when the connection or
		// process context ends for a reason other than an explicit Run cancel.
		return nil
	}
	reportContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := h.OnQueuedCanceled(reportContext, record, send); err != nil {
		return err
	}
	return h.Inbox.ClearCancellation(record.RunID)
}

func newMessageID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(buffer)
}
