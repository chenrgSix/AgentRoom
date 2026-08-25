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
	Status        *contracts.RunExecutionStatus
	Activity      *Activity
	Output        *OutputDelta
	Reply         string
	Assessment    *contracts.Assessment
	Clarification *contracts.TaskClarificationRequest
	Error         *contracts.AgentRoomError
	Session       *contracts.LogicalSessionStatus
}

type Activity struct {
	ID      string
	Kind    string
	Phase   string
	Label   string
	Content string
	Reset   bool
}

type OutputDelta struct {
	Content string
	Reset   bool
}

type EmitFunc func(context.Context, Event) error

type Adapter interface {
	Name() string
	Capabilities() Capabilities
	Execute(context.Context, Request, EmitFunc) error
}
