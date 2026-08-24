package delivery

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"time"

	contracts "agentroom.dev/contracts/generated/go"
)

type Sender func(context.Context, any) error
type NewRunFunc func(context.Context, Record, Sender) error

type Handler struct {
	Inbox            *Inbox
	Gate             *AgentExecutionGate
	OnNew            NewRunFunc
	OnDuplicate      NewRunFunc
	OnQueuedCanceled NewRunFunc
	IsExplicitCancel func(context.Context) bool
	Now              func() time.Time
}

func (h Handler) Handle(ctx context.Context, message contracts.RunRequestedMessage, send Sender) error {
	now := time.Now().UTC()
	if h.Now != nil {
		now = h.Now().UTC()
	}
	record, duplicate, err := h.Inbox.Accept(message.Payload, now)
	if err != nil {
		return err
	}
	accepted := contracts.RunAcceptedMessage{
		ProtocolVersion: "1.0",
		MessageID:       newMessageID(),
		Timestamp:       now,
		Type:            contracts.RunAccepted,
		Payload: contracts.RunAcceptedPayload{
			AgentID:  message.Payload.TargetAgentID,
			RunID:    message.Payload.RunID,
			TraceID:  message.Payload.TraceID,
			Sequence: 1,
		},
	}
	if err := send(ctx, accepted); err != nil {
		return err
	}
	if duplicate && h.OnDuplicate != nil {
		return h.OnDuplicate(ctx, record, send)
	}
	if !duplicate && h.OnNew != nil {
		if h.Gate != nil {
			release, err := h.Gate.Acquire(ctx, message.Payload.TargetAgentID)
			if err != nil {
				return h.handleQueueExit(ctx, record, send)
			}
			defer release()
			if ctx.Err() != nil {
				return h.handleQueueExit(ctx, record, send)
			}
		}
		return h.OnNew(ctx, record, send)
	}
	return nil
}

func (h Handler) handleQueueExit(ctx context.Context, record Record, send Sender) error {
	if h.IsExplicitCancel == nil || !h.IsExplicitCancel(ctx) || h.OnQueuedCanceled == nil {
		// The durable accepted record remains recoverable when the connection or
		// process context ends for a reason other than an explicit Run cancel.
		return nil
	}
	reportContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return h.OnQueuedCanceled(reportContext, record, send)
}

func newMessageID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(buffer)
}
