package runtime

import (
	"context"
	"testing"

	contracts "agentroom.dev/contracts/generated/go"
)

func status(value contracts.RunExecutionStatus) *contracts.RunExecutionStatus {
	return &value
}

func TestFakeAdapterRunsBehindRuntimeContract(t *testing.T) {
	adapter := &FakeAdapter{}
	if err := adapter.Enqueue(FakeScript{
		ExpectedInstruction: "review",
		Events: []Event{
			{Status: status(contracts.Working)},
			{Reply: "reviewed"},
			{Status: status(contracts.Completed)},
		},
	}); err != nil {
		t.Fatal(err)
	}
	var contract Adapter = adapter
	events := make([]Event, 0)
	err := contract.Execute(context.Background(), Request{
		Run: contracts.RunRequestedPayload{Instruction: "review"},
	}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[1].Reply != "reviewed" {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestFakeAdapterRejectsNonTerminalScript(t *testing.T) {
	adapter := &FakeAdapter{}
	if err := adapter.Enqueue(FakeScript{Events: []Event{{Status: status(contracts.Working)}}}); err == nil {
		t.Fatal("expected non-terminal script to fail")
	}
}
