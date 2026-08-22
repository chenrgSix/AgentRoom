package runtime

import "testing"

func TestCodexEventParserExtractsTerminalAgentMessage(t *testing.T) {
	parser := &CodexEventParser{}
	lines := []string{
		`{"type":"thread.started","thread_id":"019d-thread"}`,
		`{"type":"turn.started"}`,
		`{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"go test ./..."}}`,
		`{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Implemented and tested."}}`,
		`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}`,
	}
	for _, line := range lines {
		if err := parser.Consume([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	if parser.ThreadID != "019d-thread" || parser.Reply != "Implemented and tested." || !parser.Complete {
		t.Fatalf("unexpected parser state: %#v", parser)
	}
}

func TestCodexEventParserRejectsMalformedRequiredEvents(t *testing.T) {
	parser := &CodexEventParser{}
	if err := parser.Consume([]byte(`{"type":"thread.started"}`)); err == nil {
		t.Fatal("expected missing thread ID to fail")
	}
	if err := parser.Consume([]byte(`not-json`)); err == nil {
		t.Fatal("expected malformed JSON to fail")
	}
	if err := parser.Consume([]byte(`{"type":"future.event","value":1}`)); err != nil {
		t.Fatalf("unknown additive event should be ignored: %v", err)
	}
}

func TestCodexEventParserCapturesTurnFailure(t *testing.T) {
	parser := &CodexEventParser{}
	if err := parser.Consume([]byte(`{"type":"turn.failed","error":{"message":"model unavailable"}}`)); err != nil {
		t.Fatal(err)
	}
	if parser.Failure != "model unavailable" {
		t.Fatalf("unexpected failure: %q", parser.Failure)
	}
}
