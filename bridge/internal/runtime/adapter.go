package runtime

import (
	"context"

	contracts "agentroom.dev/contracts/generated/go"
)

type Capabilities struct {
	SupportsResume    bool
	SupportsStreaming bool
	SupportsInterrupt bool
	SupportsHandoff   bool
}

type Request struct {
	Run contracts.RunRequestedPayload
}

type Event struct {
	Status *contracts.RunExecutionStatus
	Reply  string
	Error  *contracts.AgentRoomError
}

type EmitFunc func(context.Context, Event) error

type Adapter interface {
	Name() string
	Capabilities() Capabilities
	Execute(context.Context, Request, EmitFunc) error
}
