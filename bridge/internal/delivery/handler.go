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
	Inbox       *Inbox
	OnNew       NewRunFunc
	OnDuplicate NewRunFunc
	Now         func() time.Time
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
		return h.OnNew(ctx, record, send)
	}
	return nil
}

func newMessageID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(buffer)
}
