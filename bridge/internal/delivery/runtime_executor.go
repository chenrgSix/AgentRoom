package delivery

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"time"
	"unicode/utf8"

	"convenewire.dev/bridge/internal/operations"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
)

type RuntimeExecutor struct {
	Inbox                   *Inbox
	Adapters                map[string]bridgeruntime.Adapter
	Prepare                 PrepareRunFunc
	IsPrepareRetryable      func(error) bool
	ResolveArtifacts        func(contracts.RunRequestedPayload) ([]bridgeruntime.VerifiedArtifactAlias, error)
	Now                     func() time.Time
	Observer                operations.Observer
	ShareReasoningSummaries bool
}

func (e RuntimeExecutor) Execute(ctx context.Context, record Record, send Sender) error {
	var artifacts []bridgeruntime.VerifiedArtifactAlias
	var artifactErr error
	if e.ResolveArtifacts != nil {
		artifacts, artifactErr = e.ResolveArtifacts(record.Request)
	} else if runHasPinnedArtifactContent(record.Request) {
		artifactErr = fmt.Errorf("Runtime Artifact resolver is unavailable")
	}
	if artifactErr == nil {
		artifacts, artifactErr = bridgeruntime.ValidateArtifactAliases(
			record.Request,
			artifacts,
		)
	}
	if artifactErr != nil {
		return e.failBeforeRuntime(
			ctx,
			record,
			send,
			"ARTIFACT_RUNTIME_ALIAS_INVALID",
			"Verified Artifact aliases could not be admitted to the Runtime.",
		)
	}
	startedAt := e.now()
	e.Observer.Runtime(operations.RuntimeEvent{
		At: startedAt, AgentID: record.Request.TargetAgentID, RunID: record.RunID,
		State: operations.RuntimeWorking, ActiveDelta: 1, LastStatus: string(contracts.Working),
	})
	finished := operations.RuntimeEvent{
		AgentID: record.Request.TargetAgentID, RunID: record.RunID,
		State: operations.RuntimeError, ActiveDelta: -1,
		LastStatus: string(contracts.OutcomeUnknown), ErrorCode: "RUNTIME_EXECUTION_UNKNOWN",
	}
	defer func() {
		finished.At = e.now()
		e.Observer.Runtime(finished)
	}()
	adapter := e.Adapters[record.Request.TargetAgentID]
	if adapter == nil {
		finished.ErrorCode = "RUNTIME_ADAPTER_MISSING"
		return e.emitUnknown(ctx, record, send, "RUNTIME_ADAPTER_MISSING")
	}
	sequence := record.LastSequence
	currentState := record.State
	err := adapter.Execute(ctx, bridgeruntime.Request{
		Run: record.Request, Artifacts: artifacts,
	}, func(eventContext context.Context, event bridgeruntime.Event) error {
		if event.Status == nil && event.Activity != nil &&
			event.Activity.Kind == "reasoning" && !e.ShareReasoningSummaries {
			return nil // No persisted content and no sequence gap for withheld summaries.
		}
		sequence++
		now := time.Now().UTC()
		if e.Now != nil {
			now = e.Now().UTC()
		}
		if event.Status != nil {
			finished.LastStatus = string(*event.Status)
			if event.Error != nil {
				finished.ErrorCode = event.Error.Code
			}
			switch *event.Status {
			case contracts.Completed:
				finished.State = operations.RuntimeIdle
				finished.ErrorCode = ""
			case contracts.Canceled:
				finished.State = operations.RuntimeIdle
				finished.ErrorCode = ""
			case contracts.InputRequired:
				finished.State = operations.RuntimeIdle
				finished.ErrorCode = ""
			case contracts.Failed, contracts.OutcomeUnknown:
				finished.State = operations.RuntimeError
			}
			currentState = stateForStatus(*event.Status)
			clarification := redactRuntimeClarification(event.Clarification, artifacts)
			runtimeBoundaryError := redactRuntimeError(event.Error, artifacts)
			message := contracts.RunStatusMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunStatus,
				Payload: contracts.RunStatusPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID:  record.Request.TraceID,
					Sequence: sequence, Status: *event.Status, Error: runtimeBoundaryError,
					Session: event.Session, Clarification: clarification,
				},
			}
			if _, err := e.Inbox.AppendEvent(record.RunID, currentState, sequence, message, now); err != nil {
				return err
			}
			sendContext := eventContext
			cancelSend := func() {}
			if isTerminalState(currentState) && eventContext.Err() != nil {
				sendContext, cancelSend = context.WithTimeout(
					context.WithoutCancel(eventContext), 5*time.Second,
				)
			}
			defer cancelSend()
			return send(sendContext, message)
		}
		if event.Activity != nil {
			activity := event.Activity
			activityID := bridgeruntime.RedactRuntimeText(activity.ID, artifacts)
			if activityID == "" || utf8.RuneCountInString(activityID) > 160 ||
				(activity.Kind != "reasoning" && activity.Kind != "tool") ||
				(activity.Phase != "started" && activity.Phase != "updated" &&
					activity.Phase != "completed" && activity.Phase != "failed") {
				return fmt.Errorf("Runtime emitted an invalid activity event")
			}
			label := bridgeruntime.RedactRuntimeText(activity.Label, artifacts)
			content := bridgeruntime.RedactRuntimeText(activity.Content, artifacts)
			if utf8.RuneCountInString(label) > 120 ||
				utf8.RuneCountInString(content) > 4_000 {
				return fmt.Errorf("Runtime activity exceeded its safe limit")
			}
			var labelValue *string
			if label != "" {
				labelValue = &label
			}
			var contentValue *string
			if content != "" {
				contentValue = &content
			}
			var reset *bool
			if activity.Reset {
				value := true
				reset = &value
			}
			message := contracts.RunActivityMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunActivity,
				Payload: contracts.RunActivityPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID: record.Request.TraceID, Sequence: sequence,
					ActivityID: activityID, Kind: activity.Kind,
					Phase: activity.Phase, Label: labelValue,
					Content: contentValue, Reset: reset,
				},
			}
			if _, err := e.Inbox.AppendEvent(record.RunID, currentState, sequence, message, now); err != nil {
				return err
			}
			return send(eventContext, message)
		}
		if event.Output != nil {
			if event.Output.Content == "" {
				return fmt.Errorf("Runtime emitted an empty output delta")
			}
			content := bridgeruntime.RedactRuntimeText(event.Output.Content, artifacts)
			var reset *bool
			if event.Output.Reset {
				value := true
				reset = &value
			}
			message := contracts.RunOutputDeltaMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunOutputDelta,
				Payload: contracts.RunOutputDeltaPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID: record.Request.TraceID, Sequence: sequence,
					Content: content, Reset: reset,
				},
			}
			if _, err := e.Inbox.AppendEvent(record.RunID, currentState, sequence, message, now); err != nil {
				return err
			}
			return send(eventContext, message)
		}
		if event.Reply == "" {
			return fmt.Errorf("Runtime emitted an empty event")
		}
		content := bridgeruntime.RedactRuntimeText(event.Reply, artifacts)
		message := contracts.RunReplyMessage{
			ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
			Type: contracts.RunReply,
			Payload: contracts.RunReplyPayload{
				RunID: record.RunID, AgentID: record.Request.TargetAgentID,
				TraceID:  record.Request.TraceID,
				Sequence: sequence, Content: content,
				Assessment: redactRuntimeAssessment(event.Assessment, artifacts),
			},
		}
		if _, err := e.Inbox.AppendEvent(record.RunID, currentState, sequence, message, now); err != nil {
			return err
		}
		return send(eventContext, message)
	})
	if err != nil {
		finished.State = operations.RuntimeError
		finished.LastStatus = string(contracts.OutcomeUnknown)
		finished.ErrorCode = "RUNTIME_EXECUTION_UNKNOWN"
		latest, loadErr := e.Inbox.Get(record.RunID)
		if loadErr != nil {
			return loadErr
		}
		return e.emitUnknown(ctx, latest, send, "RUNTIME_EXECUTION_UNKNOWN")
	}
	return e.clearTerminalCancellationFence(record.Request)
}

func (e RuntimeExecutor) now() time.Time {
	if e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}

func isTerminalState(state State) bool {
	return state == StateInputRequired || state == StateCompleted || state == StateFailed ||
		state == StateCanceled || state == StateOutcomeUnknown
}

func (e RuntimeExecutor) CancelQueued(ctx context.Context, record Record, send Sender) error {
	latest, err := e.Inbox.Get(record.RunID)
	if err != nil {
		return err
	}
	if isCancellationTerminalState(latest.State) {
		return e.Replay(ctx, latest, send)
	}
	if latest.State == StatePreparing {
		latest, err = e.Inbox.TransitionLocalState(
			latest.RunID, StatePreparing, StateAccepted, e.now(),
		)
		if err != nil {
			return err
		}
	}
	if latest.State != StateAccepted && latest.State != StateWorking &&
		latest.State != StateInputRequired {
		return fmt.Errorf("Run cannot be canceled before admission: %s", latest.State)
	}
	now := e.now()
	sequence := latest.LastSequence + 1
	message := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
		Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: latest.RunID, AgentID: latest.Request.TargetAgentID,
			TraceID: latest.Request.TraceID, Sequence: sequence, Status: contracts.Canceled,
		},
	}
	updated, err := e.Inbox.AppendEvent(
		latest.RunID, StateCanceled, sequence, message, now,
	)
	if err != nil {
		return err
	}
	if latest.State == StateAccepted {
		return send(ctx, message)
	}
	return e.Replay(ctx, updated, send)
}

func (e RuntimeExecutor) FailMaterialization(
	ctx context.Context,
	record Record,
	send Sender,
	_cause error,
) error {
	return e.failBeforeRuntime(
		ctx,
		record,
		send,
		"ARTIFACT_MATERIALIZATION_FAILED",
		"Pinned Artifact content could not be verified in isolated staging.",
	)
}

func (e RuntimeExecutor) failBeforeRuntime(
	ctx context.Context,
	record Record,
	send Sender,
	code string,
	messageText string,
) error {
	latest, err := e.Inbox.Get(record.RunID)
	if err != nil {
		return err
	}
	if isTerminalState(latest.State) {
		return e.Replay(ctx, latest, send)
	}
	now := e.now()
	sequence := latest.LastSequence + 1
	message := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
		Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: latest.RunID, AgentID: latest.Request.TargetAgentID,
			TraceID: latest.Request.TraceID, Sequence: sequence,
			Status: contracts.Failed,
			Error: &contracts.ConveneWireError{
				Code:      code,
				Message:   messageText,
				Retryable: false,
			},
		},
	}
	if _, err := e.Inbox.AppendEvent(
		latest.RunID,
		StateFailed,
		sequence,
		message,
		now,
	); err != nil {
		return err
	}
	if err := send(ctx, message); err != nil {
		return err
	}
	return e.clearTerminalCancellationFence(record.Request)
}

func runHasPinnedArtifactContent(run contracts.RunRequestedPayload) bool {
	if run.ContextPlan == nil || run.ContextPlan.ResultEvidence == nil {
		return false
	}
	for _, reference := range run.ContextPlan.ResultEvidence.ArtifactRefs {
		if reference.Content != nil {
			return true
		}
	}
	return false
}

func redactRuntimeClarification(
	clarification *contracts.TaskClarificationRequest,
	artifacts []bridgeruntime.VerifiedArtifactAlias,
) *contracts.TaskClarificationRequest {
	if clarification == nil {
		return nil
	}
	redacted := *clarification
	redacted.Question = bridgeruntime.RedactRuntimeText(redacted.Question, artifacts)
	redacted.Choices = append([]string(nil), clarification.Choices...)
	for index := range redacted.Choices {
		redacted.Choices[index] = bridgeruntime.RedactRuntimeText(
			redacted.Choices[index],
			artifacts,
		)
	}
	return &redacted
}

func redactRuntimeError(
	runtimeBoundaryError *contracts.ConveneWireError,
	artifacts []bridgeruntime.VerifiedArtifactAlias,
) *contracts.ConveneWireError {
	if runtimeBoundaryError == nil {
		return nil
	}
	redacted := *runtimeBoundaryError
	redacted.Message = bridgeruntime.RedactRuntimeText(redacted.Message, artifacts)
	redacted.Details = redactRuntimeDetailMap(redacted.Details, artifacts)
	return &redacted
}

func redactRuntimeDetailMap(
	details map[string]interface{},
	artifacts []bridgeruntime.VerifiedArtifactAlias,
) map[string]interface{} {
	if details == nil {
		return nil
	}
	redacted := make(map[string]interface{}, len(details))
	for key, value := range details {
		redacted[bridgeruntime.RedactRuntimeText(key, artifacts)] =
			redactRuntimeDetail(value, artifacts)
	}
	return redacted
}

func redactRuntimeDetail(
	value interface{},
	artifacts []bridgeruntime.VerifiedArtifactAlias,
) interface{} {
	switch typed := value.(type) {
	case string:
		return bridgeruntime.RedactRuntimeText(typed, artifacts)
	case map[string]interface{}:
		return redactRuntimeDetailMap(typed, artifacts)
	case []interface{}:
		redacted := make([]interface{}, len(typed))
		for index := range typed {
			redacted[index] = redactRuntimeDetail(typed[index], artifacts)
		}
		return redacted
	case []string:
		redacted := make([]string, len(typed))
		for index := range typed {
			redacted[index] = bridgeruntime.RedactRuntimeText(typed[index], artifacts)
		}
		return redacted
	default:
		return value
	}
}

func redactRuntimeAssessment(
	assessment *contracts.Assessment,
	artifacts []bridgeruntime.VerifiedArtifactAlias,
) *contracts.Assessment {
	if assessment == nil {
		return nil
	}
	redacted := *assessment
	redacted.NewEvidenceRefs = append([]string(nil), assessment.NewEvidenceRefs...)
	for index := range redacted.NewEvidenceRefs {
		redacted.NewEvidenceRefs[index] = bridgeruntime.RedactRuntimeText(
			redacted.NewEvidenceRefs[index],
			artifacts,
		)
	}
	redacted.OpenQuestions = append(
		[]contracts.OpenQuestionElement(nil),
		assessment.OpenQuestions...,
	)
	for index := range redacted.OpenQuestions {
		redacted.OpenQuestions[index].ID = bridgeruntime.RedactRuntimeText(
			redacted.OpenQuestions[index].ID,
			artifacts,
		)
		redacted.OpenQuestions[index].Question = bridgeruntime.RedactRuntimeText(
			redacted.OpenQuestions[index].Question,
			artifacts,
		)
	}
	redacted.ResolvedQuestionIDS = append(
		[]string(nil),
		assessment.ResolvedQuestionIDS...,
	)
	for index := range redacted.ResolvedQuestionIDS {
		redacted.ResolvedQuestionIDS[index] = bridgeruntime.RedactRuntimeText(
			redacted.ResolvedQuestionIDS[index],
			artifacts,
		)
	}
	return &redacted
}

func (e RuntimeExecutor) emitUnknown(ctx context.Context, record Record, send Sender, code string) error {
	now := time.Now().UTC()
	if e.Now != nil {
		now = e.Now().UTC()
	}
	sequence := record.LastSequence + 1
	message := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
		Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: record.RunID, AgentID: record.Request.TargetAgentID,
			TraceID:  record.Request.TraceID,
			Sequence: sequence, Status: contracts.OutcomeUnknown,
			Error: &contracts.ConveneWireError{
				Code: code, Message: "Runtime outcome could not be determined.", Retryable: false,
			},
		},
	}
	if _, err := e.Inbox.AppendEvent(record.RunID, StateOutcomeUnknown, sequence, message, now); err != nil {
		return err
	}
	if err := send(ctx, message); err != nil {
		return err
	}
	return e.clearTerminalCancellationFence(record.Request)
}

func (e RuntimeExecutor) Replay(ctx context.Context, record Record, send Sender) error {
	latest, err := e.Inbox.Get(record.RunID)
	if err != nil {
		return err
	}
	if err := validateRecoveryRecord(latest); err != nil {
		return err
	}
	for _, event := range latest.Events {
		if !e.ShareReasoningSummaries {
			event, err = privateReasoningReplay(event)
			if err != nil {
				return err
			}
		}
		if err := send(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

// ReplayCanceledRun closes the Central cancellation acknowledgement gap without
// restarting a Runtime. It replays a terminal record or durably fences and
// terminates a matching record that has not yet reached a terminal state.
func (e RuntimeExecutor) ReplayCanceledRun(
	ctx context.Context,
	requested contracts.RunCancelRequestedMessage,
	send Sender,
) error {
	record, err := e.Inbox.Get(requested.Payload.RunID)
	if err != nil {
		if os.IsNotExist(err) {
			tombstone, recordErr := e.Inbox.RecordCancellation(requested, e.now())
			if recordErr != nil {
				return recordErr
			}
			if err := send(ctx, cancellationTombstoneStatus(tombstone)); err != nil {
				return err
			}
			return e.Inbox.ClearCancellation(tombstone.RunID)
		}
		return fmt.Errorf("load canceled Run replay record: %w", err)
	}
	if err := validateRecoveryRecord(record); err != nil {
		return fmt.Errorf("canceled Run replay record is invalid: %w", err)
	}
	if record.RunID != requested.Payload.RunID ||
		record.Request.TraceID != requested.Payload.TraceID ||
		record.Request.TargetAgentID != requested.Payload.AgentID {
		return fmt.Errorf("Run cancellation replay identity mismatch")
	}
	if !isCancellationTerminalState(record.State) {
		if _, err := e.Inbox.RecordCancellation(requested, e.now()); err != nil {
			return err
		}
		return e.cancelTombstonedRecord(ctx, record, send)
	}
	if len(record.Events) == 0 {
		return fmt.Errorf("Run cancellation replay terminal record has no event")
	}
	var terminal contracts.RunStatusMessage
	if err := json.Unmarshal(record.Events[len(record.Events)-1], &terminal); err != nil {
		return fmt.Errorf("decode canceled Run terminal event: %w", err)
	}
	if terminal.ProtocolVersion != "1.0" ||
		terminal.Type != contracts.RunStatus ||
		terminal.Payload.RunID != record.RunID ||
		terminal.Payload.TraceID != record.Request.TraceID ||
		terminal.Payload.AgentID != record.Request.TargetAgentID ||
		terminal.Payload.Sequence != record.LastSequence ||
		!isCancellationTerminalStatus(terminal.Payload.Status) ||
		stateForStatus(terminal.Payload.Status) != record.State {
		return fmt.Errorf("Run cancellation replay terminal event is inconsistent")
	}
	if err := e.Replay(ctx, record, send); err != nil {
		return err
	}
	return e.Inbox.ClearCancellation(record.RunID)
}

// StageCancellation durably fences admission for an active connection worker.
// The worker remains the sole owner of accepted/terminal writes; the inactive
// replay path is deliberately not invoked concurrently with it.
func (e RuntimeExecutor) StageCancellation(
	requested contracts.RunCancelRequestedMessage,
) error {
	if _, err := e.Inbox.RecordCancellation(requested, e.now()); err != nil {
		return err
	}
	record, err := e.Inbox.Get(requested.Payload.RunID)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if isCancellationTerminalState(record.State) {
		return e.Inbox.ClearCancellation(record.RunID)
	}
	return nil
}

func (e RuntimeExecutor) clearTerminalCancellationFence(
	request contracts.RunRequestedPayload,
) error {
	record, err := e.Inbox.Get(request.RunID)
	if err != nil {
		return err
	}
	if !isCancellationTerminalState(record.State) {
		return nil
	}
	staged, err := e.Inbox.HasCancellation(request)
	if err != nil || !staged {
		return err
	}
	return e.Inbox.ClearCancellation(request.RunID)
}

func cancellationTombstoneStatus(
	tombstone CancellationTombstone,
) contracts.RunStatusMessage {
	return contracts.RunStatusMessage{
		ProtocolVersion: "1.0",
		MessageID:       tombstone.TerminalStatusMessageID,
		Timestamp:       tombstone.CreatedAt,
		Type:            contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: tombstone.RunID, TraceID: tombstone.TraceID,
			AgentID: tombstone.AgentID, Sequence: 1,
			Status: contracts.Canceled,
		},
	}
}

func (e RuntimeExecutor) cancelTombstonedRecord(
	ctx context.Context,
	record Record,
	send Sender,
) error {
	reportContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	var events []any
	if err := e.CancelQueued(
		reportContext,
		record,
		func(_ context.Context, value any) error {
			events = append(events, value)
			return nil
		},
	); err != nil {
		return err
	}
	accepted := contracts.RunAcceptedMessage{
		ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: e.now(),
		Type: contracts.RunAccepted,
		Payload: contracts.RunAcceptedPayload{
			RunID: record.RunID, TraceID: record.Request.TraceID,
			AgentID: record.Request.TargetAgentID, Sequence: 1,
		},
	}
	if runHasPinnedArtifactContent(record.Request) {
		accepted.Payload.ArtifactMaterializationError = materializationFailureAcknowledgement()
	}
	if err := send(reportContext, accepted); err != nil {
		return err
	}
	for _, event := range events {
		if err := send(reportContext, event); err != nil {
			return err
		}
	}
	return e.Inbox.ClearCancellation(record.RunID)
}

func isCancellationTerminalState(state State) bool {
	return state == StateCompleted || state == StateFailed ||
		state == StateCanceled || state == StateOutcomeUnknown
}

func isCancellationTerminalStatus(status contracts.RunExecutionStatus) bool {
	return status == contracts.Completed || status == contracts.Failed ||
		status == contracts.Canceled || status == contracts.OutcomeUnknown
}

// Old outbox entries must still occupy their original sequence on recovery.
// Consent controls every replay; local history is retained, not rewritten.
func privateReasoningReplay(source json.RawMessage) (json.RawMessage, error) {
	var envelope struct {
		Type    string `json:"type"`
		Payload struct {
			Kind string `json:"kind"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(source, &envelope); err != nil {
		return nil, fmt.Errorf("decode replay privacy envelope: %w", err)
	}
	if envelope.Type != string(contracts.RunActivity) || envelope.Payload.Kind != "reasoning" {
		return source, nil
	}
	var message contracts.RunActivityMessage
	if err := json.Unmarshal(source, &message); err != nil {
		return nil, fmt.Errorf("decode reasoning replay: %w", err)
	}
	label := "Summary sharing disabled"
	message.Payload.ActivityID = fmt.Sprintf("private-activity-%d", message.Payload.Sequence)
	message.Payload.Label = &label
	message.Payload.Content = nil
	message.Payload.Reset = nil
	return json.Marshal(message)
}

func (e RuntimeExecutor) Recover(ctx context.Context, send Sender) error {
	records, err := e.Inbox.List()
	if err != nil {
		return err
	}
	recoverable := make([]Record, 0, len(records))
	for _, record := range records {
		if err := validateRecoveryRecord(record); err != nil {
			if !isTerminalState(record.State) {
				return fmt.Errorf(
					"active inbox record has incompatible trace metadata: %s: %w",
					record.RunID,
					err,
				)
			}
			if _, quarantineErr := e.Inbox.QuarantineIncompatibleTrace(record.RunID); quarantineErr != nil {
				return quarantineErr
			}
			continue
		}
		recoverable = append(recoverable, record)
	}
	for _, record := range recoverable {
		canceledBeforeRecovery, err := e.Inbox.HasCancellation(record.Request)
		if err != nil {
			return err
		}
		if canceledBeforeRecovery {
			if err := e.cancelTombstonedRecord(ctx, record, send); err != nil {
				return err
			}
			continue
		}
		if record.State == StatePreparing {
			continue
		}
		var materializations []contracts.VerifiedArtifactMaterializationReceipt
		var prepareErr error
		if hasPersistedMaterializationFailure(record) {
			prepareErr = fmt.Errorf("persisted Artifact materialization failure")
		} else if e.Prepare != nil {
			materializations, prepareErr = e.Prepare(ctx, record.Request)
			if prepareErr != nil && e.IsPrepareRetryable != nil &&
				e.IsPrepareRetryable(prepareErr) {
				return prepareErr
			}
		}
		now := time.Now().UTC()
		if e.Now != nil {
			now = e.Now().UTC()
		}
		accepted := contracts.RunAcceptedMessage{
			ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
			Type: contracts.RunAccepted,
			Payload: contracts.RunAcceptedPayload{
				RunID: record.RunID, TraceID: record.Request.TraceID,
				AgentID: record.Request.TargetAgentID, Sequence: 1,
				ArtifactMaterializations: materializations,
			},
		}
		if prepareErr != nil {
			accepted.Payload.ArtifactMaterializationError =
				materializationFailureAcknowledgement()
		}
		if err := send(ctx, accepted); err != nil {
			return err
		}
		if record.State == StateAccepted || record.State == StateWorking {
			sequence := record.LastSequence + 1
			message := contracts.RunStatusMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunStatus,
				Payload: contracts.RunStatusPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID:  record.Request.TraceID,
					Sequence: sequence, Status: contracts.OutcomeUnknown,
					Error: &contracts.ConveneWireError{
						Code:      "RUNTIME_PROCESS_RESTARTED",
						Message:   "Bridge restarted before the Runtime terminal outcome was persisted.",
						Retryable: false,
					},
				},
			}
			if _, err := e.Inbox.AppendEvent(record.RunID, StateOutcomeUnknown, sequence, message, now); err != nil {
				return err
			}
		}
		if err := e.Replay(ctx, record, send); err != nil {
			return err
		}
	}
	return nil
}

func hasPersistedMaterializationFailure(record Record) bool {
	if record.State != StateFailed {
		return false
	}
	for index := len(record.Events) - 1; index >= 0; index-- {
		var envelope struct {
			Type    string `json:"type"`
			Payload struct {
				Status contracts.RunExecutionStatus `json:"status"`
				Error  *contracts.ConveneWireError  `json:"error"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(record.Events[index], &envelope); err != nil {
			continue
		}
		return envelope.Type == string(contracts.RunStatus) &&
			envelope.Payload.Status == contracts.Failed &&
			envelope.Payload.Error != nil &&
			envelope.Payload.Error.Code == "ARTIFACT_MATERIALIZATION_FAILED"
	}
	return false
}

func validateRecoveryRecord(record Record) error {
	if !isContractRunID(record.RunID) || record.Request.RunID != record.RunID {
		return fmt.Errorf("request Run identity does not match inbox record")
	}
	if !isContractTraceID(record.Request.TraceID) {
		return fmt.Errorf("request trace identity is invalid")
	}
	for index, source := range record.Events {
		var envelope struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(source, &envelope); err != nil {
			return fmt.Errorf("decode persisted Run event %d: %w", index, err)
		}
		switch envelope.Type {
		case string(contracts.RunStatus),
			string(contracts.RunActivity),
			string(contracts.RunOutputDelta),
			string(contracts.RunReply),
			string(contracts.RunHandoffRequested):
		default:
			return fmt.Errorf("persisted Run event %d has unsupported type", index)
		}
		var payload struct {
			RunID   string `json:"runId"`
			TraceID string `json:"traceId"`
		}
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return fmt.Errorf("decode persisted Run event payload %d: %w", index, err)
		}
		if payload.RunID != record.RunID {
			return fmt.Errorf("persisted Run event %d has a mismatched Run identity", index)
		}
		if !isContractTraceID(payload.TraceID) || payload.TraceID != record.Request.TraceID {
			return fmt.Errorf("persisted Run event %d has incompatible trace metadata", index)
		}
	}
	return nil
}

func stateForStatus(status contracts.RunExecutionStatus) State {
	switch status {
	case contracts.Working:
		return StateWorking
	case contracts.InputRequired:
		return StateInputRequired
	case contracts.Completed:
		return StateCompleted
	case contracts.Failed:
		return StateFailed
	case contracts.Canceled:
		return StateCanceled
	default:
		return StateOutcomeUnknown
	}
}

func runtimeMessageID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(buffer)
}
