package delivery

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

type RuntimeExecutor struct {
	Inbox    *Inbox
	Adapters map[string]bridgeruntime.Adapter
	Now      func() time.Time
}

func (e RuntimeExecutor) Execute(ctx context.Context, record Record, send Sender) error {
	adapter := e.Adapters[record.Request.TargetAgentID]
	if adapter == nil {
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
			currentState = stateForStatus(*event.Status)
			if _, err := e.Inbox.Update(record.RunID, currentState, sequence, now); err != nil {
				return err
			}
			return send(eventContext, contracts.RunStatusMessage{
				ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
				Type: contracts.RunStatus,
				Payload: contracts.RunStatusPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					Sequence: sequence, Status: *event.Status, Error: event.Error,
				},
			})
		}
		if event.Reply == "" {
			return fmt.Errorf("Runtime emitted an empty event")
		}
		if _, err := e.Inbox.Update(record.RunID, currentState, sequence, now); err != nil {
			return err
		}
		return send(eventContext, contracts.RunReplyMessage{
			ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
			Type: contracts.RunReply,
			Payload: contracts.RunReplyPayload{
				RunID: record.RunID, AgentID: record.Request.TargetAgentID,
				Sequence: sequence, Content: event.Reply,
			},
		})
	})
	if err != nil {
		latest, loadErr := e.Inbox.Get(record.RunID)
		if loadErr != nil {
			return loadErr
		}
		return e.emitUnknown(ctx, latest, send, "RUNTIME_EXECUTION_UNKNOWN")
	}
	return nil
}

func (e RuntimeExecutor) emitUnknown(ctx context.Context, record Record, send Sender, code string) error {
	now := time.Now().UTC()
	if e.Now != nil {
		now = e.Now().UTC()
	}
	sequence := record.LastSequence + 1
	if _, err := e.Inbox.Update(record.RunID, StateOutcomeUnknown, sequence, now); err != nil {
		return err
	}
	return send(ctx, contracts.RunStatusMessage{
		ProtocolVersion: "1.0", MessageID: runtimeMessageID(), Timestamp: now,
		Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: record.RunID, AgentID: record.Request.TargetAgentID,
			Sequence: sequence, Status: contracts.OutcomeUnknown,
			Error: &contracts.AgentRoomError{
				Code: code, Message: "Runtime outcome could not be determined.", Retryable: false,
			},
		},
	})
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
