package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestGenericAdapterPassesInstructionOnStdin(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command:   []string{"/usr/bin/tr", "a-z", "A-Z"},
		Workspace: t.TempDir(),
	}}
	var events []Event
	err := adapter.Execute(context.Background(), Request{
		Run: contracts.RunRequestedPayload{Instruction: "hello team"},
	}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[1].Reply != "HELLO TEAM" || *events[2].Status != contracts.Completed {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestGenericAdapterExtractsOptionalAssessment(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{"/bin/sh", "-c", "cat"}, Workspace: t.TempDir(),
	}}
	var report Event
	err := adapter.Execute(context.Background(), Request{Run: contracts.RunRequestedPayload{
		Instruction: "Useful answer.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>",
	}}, func(_ context.Context, event Event) error {
		if event.Reply != "" {
			report = event
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Reply != "Useful answer." || report.Assessment == nil ||
		report.Assessment.GoalSatisfied == nil || !*report.Assessment.GoalSatisfied {
		t.Fatalf("unexpected report: %#v", report)
	}
}

func TestGenericAdapterMapsDeadline(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{"/bin/sh", "-c", "sleep 2"}, Workspace: t.TempDir(),
	}}
	var terminal Event
	err := adapter.Execute(context.Background(), Request{Run: contracts.RunRequestedPayload{
		Deadline: time.Now().Add(20 * time.Millisecond),
	}}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed || terminal.Error.Code != "RUNTIME_TIMEOUT" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
}

func TestGenericAdapterBoundsOutput(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{"/usr/bin/yes", strings.Repeat("x", 100)}, Workspace: t.TempDir(),
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed || terminal.Error.Code != "RUNTIME_OUTPUT_LIMIT" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
}

func TestGenericAdapterMapsFailedExit(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{"/usr/bin/false"}, Workspace: t.TempDir(),
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed || terminal.Error.Code != "RUNTIME_EXIT_FAILED" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
	if terminal.Error.Details["exitCode"] != 1 || terminal.Error.Details["category"] != "unknown" {
		t.Fatalf("unexpected safe failure details: %#v", terminal.Error.Details)
	}
}

func TestGenericAdapterClassifiesFailureWithoutLeakingStderr(t *testing.T) {
	const seededSecret = "seeded-runtime-secret"
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{
			"/bin/sh", "-c",
			"echo 'authentication failed: " + seededSecret + "' >&2; exit 23",
		},
		Workspace: t.TempDir(),
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Error == nil || terminal.Error.Code != "RUNTIME_EXIT_FAILED" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
	if terminal.Error.Details["exitCode"] != 23 ||
		terminal.Error.Details["category"] != "authentication" ||
		terminal.Error.Details["stderrCaptured"] != true {
		t.Fatalf("unexpected safe failure details: %#v", terminal.Error.Details)
	}
	encoded, err := json.Marshal(terminal.Error)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), seededSecret) {
		t.Fatalf("runtime stderr leaked through protocol error: %s", encoded)
	}
}

func TestGenericAdapterDistinguishesStartFailure(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{"/missing/agentroom-runtime"}, Workspace: t.TempDir(),
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Error == nil || terminal.Error.Code != "RUNTIME_START_FAILED" ||
		terminal.Error.Details["category"] != "start" {
		t.Fatalf("unexpected start failure: %#v", terminal)
	}
}

func TestRuntimeFailureCategoriesAreStable(t *testing.T) {
	tests := map[string]string{
		"HTTP 429: too many requests":     "rate_limit",
		"ECONNRESET while reading socket": "network",
		"model unavailable":               "model",
		"extension initialization failed": "configuration",
		"unrecognized failure":            "unknown",
	}
	for stderr, expected := range tests {
		if actual := classifyRuntimeFailure(stderr); actual != expected {
			t.Errorf("classifyRuntimeFailure(%q) = %q, want %q", stderr, actual, expected)
		}
	}
}
