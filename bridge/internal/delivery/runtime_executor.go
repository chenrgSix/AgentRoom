package delivery

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"agentroom.dev/bridge/internal/operations"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

type RuntimeExecutor struct {
	Inbox    *Inbox
	Adapters map[string]bridgeruntime.Adapter
	Now      func() time.Time
	Observer operations.Observer
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
			case contracts.Failed, contracts.OutcomeUnknown:
				finished.State = operations.RuntimeError
			}
			currentState = stateForStatus(*event.Status)
			message := contracts.RunStatusMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunStatus,
				Payload: contracts.RunStatusPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID:  traceIDPointer(record.Request.TraceID),
					Sequence: sequence, Status: *event.Status, Error: event.Error,
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
		if event.Reply == "" {
			return fmt.Errorf("Runtime emitted an empty event")
		}
		content := bridgeruntime.RedactSensitiveText(event.Reply)
		message := contracts.RunReplyMessage{
			ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
			Type: contracts.RunReply,
			Payload: contracts.RunReplyPayload{
				RunID: record.RunID, AgentID: record.Request.TargetAgentID,
				TraceID:  traceIDPointer(record.Request.TraceID),
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
	return state == StateCompleted || state == StateFailed || state == StateOutcomeUnknown
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
			TraceID:  traceIDPointer(record.Request.TraceID),
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
	for _, record := range records {
		now := time.Now().UTC()
		if e.Now != nil {
			now = e.Now().UTC()
		}
		accepted := contracts.RunAcceptedMessage{
			ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
			Type: contracts.RunAccepted,
			Payload: contracts.RunAcceptedPayload{
				RunID: record.RunID, TraceID: traceIDPointer(record.Request.TraceID),
				AgentID: record.Request.TargetAgentID, Sequence: 1,
			},
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
					TraceID:  traceIDPointer(record.Request.TraceID),
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

func stateForStatus(status contracts.RunExecutionStatus) State {
	switch status {
	case contracts.Working, contracts.InputRequired:
		return StateWorking
	case contracts.Completed:
		return StateCompleted
	case contracts.Failed, contracts.Canceled:
		return StateFailed
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
