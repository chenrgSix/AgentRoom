package operations

import "time"

type ConnectionState string

const (
	ConnectionStopped    ConnectionState = "stopped"
	ConnectionConnecting ConnectionState = "connecting"
	ConnectionOnline     ConnectionState = "online"
	ConnectionRetrying   ConnectionState = "retrying"
)

type RuntimeState string

const (
	RuntimeIdle    RuntimeState = "idle"
	RuntimeWorking RuntimeState = "working"
	RuntimeError   RuntimeState = "error"
)

type ConnectionEvent struct {
	At            time.Time
	State         ConnectionState
	Attempt       int
	NextRetryAt   *time.Time
	Error         string
	ConnectedOnce bool
}

type RuntimeEvent struct {
	At          time.Time
	AgentID     string
	AgentName   string
	RunID       string
	State       RuntimeState
	ActiveDelta int
	LastStatus  string
	ErrorCode   string
}

// Observer is optional. Callers that do not need a local operational
// projection may pass the zero value without changing Bridge behavior.
type Observer struct {
	OnConnection func(ConnectionEvent)
	OnRuntime    func(RuntimeEvent)
}

func (o Observer) Connection(event ConnectionEvent) {
	if o.OnConnection != nil {
		o.OnConnection(event)
	}
}

func (o Observer) Runtime(event RuntimeEvent) {
	if o.OnRuntime != nil {
		o.OnRuntime(event)
	}
}
