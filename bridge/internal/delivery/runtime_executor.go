package delivery

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"agentroom.dev/bridge/internal/operations"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

type RuntimeExecutor struct {
	Inbox              *Inbox
	Adapters           map[string]bridgeruntime.Adapter
	Prepare            PrepareRunFunc
	IsPrepareRetryable func(error) bool
	Now                func() time.Time
	Observer           operations.Observer
}

func (e RuntimeExecutor) Execute(ctx context.Context, record Record, send Sender) error {
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
	err := adapter.Execute(ctx, bridgeruntime.Request{Run: record.Request}, func(eventContext context.Context, event bridgeruntime.Event) error {
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
			message := contracts.RunStatusMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunStatus,
				Payload: contracts.RunStatusPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID:  record.Request.TraceID,
					Sequence: sequence, Status: *event.Status, Error: event.Error,
					Session: event.Session, Clarification: event.Clarification,
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
			if activity.ID == "" || utf8.RuneCountInString(activity.ID) > 160 ||
				(activity.Kind != "reasoning" && activity.Kind != "tool") ||
				(activity.Phase != "started" && activity.Phase != "updated" &&
					activity.Phase != "completed" && activity.Phase != "failed") {
				return fmt.Errorf("Runtime emitted an invalid activity event")
			}
			label := bridgeruntime.RedactSensitiveText(activity.Label)
			content := bridgeruntime.RedactSensitiveText(activity.Content)
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
					ActivityID: activity.ID, Kind: activity.Kind,
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
			content := bridgeruntime.RedactSensitiveText(event.Output.Content)
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
		content := bridgeruntime.RedactSensitiveText(event.Reply)
		message := contracts.RunReplyMessage{
			ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
			Type: contracts.RunReply,
			Payload: contracts.RunReplyPayload{
				RunID: record.RunID, AgentID: record.Request.TargetAgentID,
				TraceID:  record.Request.TraceID,
				Sequence: sequence, Content: content, Assessment: event.Assessment,
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
	return nil
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
	if latest.State != StateAccepted {
		return e.Replay(ctx, latest, send)
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
	if _, err := e.Inbox.AppendEvent(
		latest.RunID, StateCanceled, sequence, message, now,
	); err != nil {
		return err
	}
	return send(ctx, message)
}

func (e RuntimeExecutor) FailMaterialization(
	ctx context.Context,
	record Record,
	send Sender,
	_cause error,
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
			Error: &contracts.AgentRoomError{
				Code:      "ARTIFACT_MATERIALIZATION_FAILED",
				Message:   "Pinned Artifact content could not be verified in isolated staging.",
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
	return send(ctx, message)
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
			Error: &contracts.AgentRoomError{
				Code: code, Message: "Runtime outcome could not be determined.", Retryable: false,
			},
		},
	}
	if _, err := e.Inbox.AppendEvent(record.RunID, StateOutcomeUnknown, sequence, message, now); err != nil {
		return err
	}
	return send(ctx, message)
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
		if err := send(ctx, event); err != nil {
			return err
		}
	}
	return nil
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
		if record.State == StatePreparing {
			continue
		}
		var materializations []contracts.VerifiedArtifactMaterializationReceipt
		var prepareErr error
		if e.Prepare != nil {
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
					Error: &contracts.AgentRoomError{
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
