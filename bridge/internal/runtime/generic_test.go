package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
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
	if adapter.Capabilities().SupportsStreaming {
		t.Fatal("plain stdout Generic Runtime must remain final-only")
	}
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

func TestGenericAdapterStreamsOptInStructuredOutput(t *testing.T) {
	text := strings.Repeat("streaming ", 12)
	firstLine := `{"type":"assistant.delta","delta":` + quotedJSON(t, text) + `}`
	finalLine := `{"type":"reply.final","text":` + quotedJSON(t, text) + `}`
	script := "printf '%s\\n' '" + firstLine + "'; sleep 0.2; printf '%s\\n' '" + finalLine + "'"
	adapter := GenericAdapter{Config: config.AgentConfig{
		Command: []string{"/bin/sh", "-c", script}, Workspace: t.TempDir(),
		RuntimeKind: "generic", OutputProtocol: config.OutputProtocolAgentRoomJSONLV1,
	}}
	if !adapter.Capabilities().SupportsStreaming {
		t.Fatal("structured Generic Runtime did not publish streaming capability")
	}
	var previewAt time.Time
	var replyAt time.Time
	var reply string
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		if event.Output != nil && previewAt.IsZero() {
			previewAt = time.Now()
		}
		if event.Reply != "" {
			replyAt = time.Now()
			reply = event.Reply
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if previewAt.IsZero() || replyAt.IsZero() || !previewAt.Before(replyAt) ||
		reply != strings.TrimSpace(text) {
		t.Fatalf("Generic preview was not emitted before final reply: preview=%s reply=%s content=%q", previewAt, replyAt, reply)
	}
}

func TestGenericStreamParserResetsAndWithholdsPrivateTail(t *testing.T) {
	parser := &genericStreamParser{}
	first, err := parser.consume([]byte(`{"type":"assistant.delta","delta":"` + strings.Repeat("A", 80) + `"}`))
	if err != nil || first == nil || first.Reset || first.Content != strings.Repeat("A", 16) {
		t.Fatalf("unexpected first Generic preview: %#v, %v", first, err)
	}
	secret := strings.Repeat("visible ", 12) + "token=very-sensitive-value" + strings.Repeat(" trailing", 12)
	second, err := parser.consume([]byte(`{"type":"assistant.delta","reset":true,"delta":` + quotedJSON(t, secret) + `}`))
	if err != nil || second == nil || !second.Reset || strings.Contains(second.Content, "very-sensitive") {
		t.Fatalf("Generic reset leaked private output: %#v, %v", second, err)
	}
	final, err := parser.consume([]byte(`{"type":"reply.final","text":"Safe final.` +
		`\n<agentroom-assessment>{\"goalSatisfied\":true}</agentroom-assessment>"}`))
	if err != nil || final == nil || !final.Reset || final.Content != "Safe final." ||
		parser.finalReply == "" {
		t.Fatalf("unexpected Generic final event: %#v, %v", final, err)
	}
}

func TestGenericStructuredAdapterFailsClosedOnInvalidStreams(t *testing.T) {
	for _, mode := range []string{"malformed", "missing-final", "tool-leak"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("AGENTROOM_GENERIC_HELPER", mode)
			adapter := GenericAdapter{Config: config.AgentConfig{
				Command: []string{os.Args[0], "-test.run=TestGenericHelperProcess"}, Workspace: t.TempDir(),
				RuntimeKind: "generic", OutputProtocol: config.OutputProtocolAgentRoomJSONLV1,
				EnvAllowlist: []string{"AGENTROOM_GENERIC_HELPER"},
			}}
			var terminal Event
			if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
				terminal = event
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if terminal.Status == nil || *terminal.Status != contracts.Failed || terminal.Error == nil ||
				terminal.Error.Code != "RUNTIME_PROTOCOL_INVALID" || terminal.Reply != "" {
				t.Fatalf("invalid Generic stream escaped fail-closed boundary: %#v", terminal)
			}
		})
	}
}

func TestGenericHelperProcess(t *testing.T) {
	switch os.Getenv("AGENTROOM_GENERIC_HELPER") {
	case "stream":
		text := strings.Repeat("streaming ", 12)
		fmt.Println(`{"type":"assistant.delta","delta":` + quotedJSON(t, text) + `}`)
		_ = os.Stdout.Sync()
		time.Sleep(200 * time.Millisecond)
		fmt.Println(`{"type":"reply.final","text":` + quotedJSON(t, text) + `}`)
	case "malformed":
		fmt.Println(`not-json`)
	case "missing-final":
		fmt.Println(`{"type":"runtime.status","state":"done"}`)
	case "tool-leak":
		fmt.Println(`{"type":"reply.final","text":"<tool_call><tool_name>bash</tool_name></tool_call>"}`)
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
		"EPERM: operation not permitted":  "configuration",
		"unrecognized failure":            "unknown",
	}
	for stderr, expected := range tests {
		if actual := classifyRuntimeFailure(stderr); actual != expected {
			t.Errorf("classifyRuntimeFailure(%q) = %q, want %q", stderr, actual, expected)
		}
	}
}
