package delivery

import (
	"context"
	"errors"
	"testing"

	contracts "convenewire.dev/contracts/generated/go"
)

func TestUnsupportedGovernedExecutionCannotFallBackToOrdinaryRuntime(t *testing.T) {
	request := contracts.RunRequestedPayload{
		ContextManifest: &contracts.ContextManifest{Execution: &contracts.Execution{}},
	}
	called := false
	send := func(context.Context, any) error { called = true; return nil }
	handler := Handler{
		// A nil Inbox additionally proves rejection precedes persistent acceptance.
		OnNew: func(context.Context, Record, Sender) error { called = true; return nil },
	}
	if err := handler.Handle(context.Background(), contracts.RunRequestedMessage{Payload: request}, send); !errors.Is(err, ErrGovernedExecutionUnsupported) {
		t.Fatalf("handler error=%v", err)
	}
	if err := (RuntimeExecutor{}).Execute(context.Background(), Record{Request: request}, send); !errors.Is(err, ErrGovernedExecutionUnsupported) {
		t.Fatalf("executor error=%v", err)
	}
	if called {
		t.Fatal("unsupported governed execution was acknowledged or invoked")
	}
}
