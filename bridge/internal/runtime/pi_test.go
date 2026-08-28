package runtime

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	contracts "convenewire.dev/contracts/generated/go"
)

var (
	piHelperSessionID   = flag.String("session-id", "", "Pi helper session id")
	piHelperSessionName = flag.String("name", "", "Pi helper session name")
)

func TestPiAdapterExtractsFinalAssistantReplyAndAssessment(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"session","version":3}`,
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Useful review.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>"}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 4 || events[1].Output == nil ||
		events[1].Output.Content != "Useful review." ||
		events[2].Reply != "Useful review." || events[2].Assessment == nil ||
		events[2].Assessment.GoalSatisfied == nil ||
		!*events[2].Assessment.GoalSatisfied || events[3].Status == nil ||
		*events[3].Status != contracts.Completed {
		t.Fatalf("unexpected Pi events: %#v", events)
	}
}

func TestPiAdapterEmitsTaskClarificationWithoutReply(t *testing.T) {
	output := `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"<agentroom-clarification>{\"kind\":\"task\",\"question\":\"Which region?\"}</agentroom-clarification>"}],"stopReason":"stop"}}`
	events := executePiFixture(t, output)
	if len(events) != 2 || events[1].Status == nil ||
		*events[1].Status != contracts.InputRequired ||
		events[1].Clarification == nil ||
		events[1].Clarification.Question != "Which region?" || events[1].Reply != "" {
		t.Fatalf("unexpected Pi clarification events: %#v", events)
	}
}

func TestPiAdapterProjectsBoundedToolLifecycleAndReturnsFinalReply(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I will inspect it."},{"type":"toolCall","name":"read"}],"stopReason":"toolUse"}}`,
		`{"type":"tool_execution_start","toolName":"read"}`,
		`{"type":"tool_execution_end","toolName":"read","isError":false}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"The project uses Go and TypeScript."}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 6 || events[1].Activity == nil ||
		events[1].Activity.Kind != "tool" || events[1].Activity.Phase != "started" ||
		events[1].Activity.Label != "read" || events[2].Activity == nil ||
		events[2].Activity.Phase != "completed" || events[3].Output == nil ||
		events[3].Output.Content != "The project uses Go and TypeScript." ||
		events[4].Reply != "The project uses Go and TypeScript." ||
		events[5].Status == nil || *events[5].Status != contracts.Completed {
		t.Fatalf("unexpected Pi tool lifecycle projection: %#v", events)
	}
}

func TestPiAdapterProjectsExplicitThinkingDeltas(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Inspecting the request."}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 6 || events[1].Activity == nil ||
		events[1].Activity.Kind != "reasoning" ||
		events[1].Activity.Content != "Inspecting the request." ||
		events[2].Activity == nil || events[2].Activity.Phase != "completed" ||
		events[3].Output == nil || events[4].Reply != "Done." ||
		events[5].Status == nil || *events[5].Status != contracts.Completed {
		t.Fatalf("unexpected Pi thinking projection: %#v", events)
	}
}

func TestPiAdapterEmitsPreviewBeforeFinalReply(t *testing.T) {
	t.Setenv("AGENTROOM_PI_HELPER", "stream")
	adapter := PiAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestPiHelperProcess", "--"},
		Workspace: t.TempDir(), EnvAllowlist: []string{"AGENTROOM_PI_HELPER"},
	}}
	var previewAt time.Time
	var replyAt time.Time
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		if event.Output != nil && previewAt.IsZero() {
			previewAt = time.Now()
		}
		if event.Reply != "" {
			replyAt = time.Now()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if previewAt.IsZero() || replyAt.IsZero() || !previewAt.Before(replyAt) {
		t.Fatalf("preview was not emitted before final reply: preview=%s reply=%s", previewAt, replyAt)
	}
}

func TestPiAdapterUsesPersistentTaskAgentSession(t *testing.T) {
	t.Setenv("AGENTROOM_PI_HELPER", "session")
	workspace := t.TempDir()
	t.Setenv("AGENTROOM_PI_WORKSPACE", workspace)
	name := "我的 Pi"
	configuration := config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestPiHelperProcess"},
		Workspace: workspace, EnvAllowlist: []string{
			"AGENTROOM_PI_HELPER", "AGENTROOM_PI_WORKSPACE", "AGENTROOM_PI_EXPECTED_SESSION_ID",
			"AGENTROOM_PI_REQUIRED_CONTEXT", "AGENTROOM_PI_FORBIDDEN_CONTEXT",
			"AGENTROOM_PI_FORBIDDEN_ARTIFACT",
		},
		RuntimeKind: "pi", PresetVersion: config.CurrentPresetVersion,
	}
	store := NewFileRuntimeSessionStore(t.TempDir())
	adapter := PiAdapter{Config: configuration, Sessions: store}
	taskID := "task_alpha"
	content := contracts.PinnedArtifactContent{
		ContentID:    "content_pi_runtime_12345678",
		LogicalAlias: "artifact://artifact_pi_12345678/result.patch",
		MediaType:    contracts.TextXDiff,
		Sha256:       strings.Repeat("e", 64), SizeBytes: 19,
	}
	artifactAlias := VerifiedArtifactAlias{
		ArtifactID: "artifact_pi_12345678", ContentID: content.ContentID,
		LogicalAlias: content.LogicalAlias,
		LocalPath:    "/private/tmp/convenewire/pi/result.patch",
		MediaType:    content.MediaType, SHA256: content.Sha256, SizeBytes: content.SizeBytes,
	}
	request := Request{Run: contracts.RunRequestedPayload{
		RunID: "run_first", RoomID: "room_alpha", TaskID: &taskID,
		TargetAgentID: "agent_pi", TargetAgentName: &name,
		Session: &contracts.LogicalSessionRequest{
			Scope: contracts.Task, ResumePolicy: contracts.ResumeOrStart, ContextCursor: 7,
		},
		ContextPlan: &contracts.RuntimeContextPlan{
			RoomMemory: &contracts.RoomMemoryClass{
				Revision: 2, SourceCursor: 3, Summary: "Room memory",
			},
			TaskMemory: &contracts.TaskMemoryClass{
				Revision: 4, SourceCursor: 4, Summary: "Task memory",
			},
			ResultEvidence: &contracts.TaskResultEvidence{
				Revision: 5,
				ArtifactRefs: []contracts.ArtifactReference{{
					ArtifactID: "artifact_pi_12345678", Type: contracts.Commit,
					Title: "Pi result", Summary: "Verify locally", Content: &content,
				}},
			},
		},
	}, Artifacts: []VerifiedArtifactAlias{artifactAlias}}
	plan, eligible, err := planRuntimeSession("pi", configuration, request.Run)
	if err != nil || !eligible {
		t.Fatalf("could not plan Pi Task Session: eligible=%t err=%v", eligible, err)
	}
	expectedSessionID := piSessionID(plan.Key, request.Run.RunID)
	t.Setenv("AGENTROOM_PI_EXPECTED_SESSION_ID", expectedSessionID)
	t.Setenv("AGENTROOM_PI_REQUIRED_CONTEXT", artifactAlias.LocalPath)
	var reply string
	var terminal Event
	if err := adapter.Execute(context.Background(), request, func(_ context.Context, event Event) error {
		if event.Reply != "" {
			reply = event.Reply
		}
		if event.Status != nil {
			terminal = event
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if reply != "Session resumed." {
		t.Fatalf("unexpected Pi session reply: %q", reply)
	}
	if terminal.Session == nil || terminal.Session.Disposition != contracts.Started ||
		terminal.Session.ContextCursor != 7 {
		t.Fatalf("new Pi Task Session was not reported: %#v", terminal)
	}
	binding, found, err := store.Load(plan.Key)
	if err != nil || !found || binding.SessionID != expectedSessionID ||
		binding.LastRoomSequence != 7 || binding.LastRunID != request.Run.RunID ||
		binding.RoomMemoryRevision != 2 || binding.TaskMemoryRevision != 4 ||
		binding.ResultEvidenceRevision != 5 {
		t.Fatalf("Pi Task Session was not persisted: %#v found=%t err=%v", binding, found, err)
	}
	request.Run.RunID = "run_second"
	request.Run.Session.ContextCursor = 9
	newSequence := int64(8)
	request.Run.TriggerMessageID = "msg_current_pi_12345678"
	request.Run.ContextMessages = []contracts.ContextMessage{}
	request.Run.RoomContextBundle = &contracts.ServerRoomContextBundle{
		TargetThroughSequence: 9, PriorContextThroughSequence: 8,
		RequestMessageID: request.Run.TriggerMessageID,
		Checkpoint: &contracts.RollingRoomCheckpoint{
			CheckpointID:          "checkpoint_pi_context_12345678",
			FromSequenceExclusive: 0, ThroughSequence: 7,
			Summary: "already-consumed-context", SourceMessageCount: 7,
			SourceDigest: strings.Repeat("d", 64), PromptVersion: "room-memory-v1",
			ModelFingerprint: "test-model-v1", BuildKind: contracts.Incremental,
			ProvenanceMessageIDS: []string{"msg_pi_provenance_12345678"},
		},
		RawTail: contracts.RoomContextRawTail{
			FromSequenceExclusive: 7, ThroughSequenceInclusive: 8,
			MessageCount: 1, Utf8Bytes: int64(len("new-room-delta")),
			Messages: []contracts.Message{{
				MessageID: "msg_new_pi_12345678", SenderID: "member_pi",
				Content: "new-room-delta", Sequence: &newSequence,
			}},
		},
	}
	t.Setenv("AGENTROOM_PI_REQUIRED_CONTEXT", "new-room-delta")
	t.Setenv("AGENTROOM_PI_FORBIDDEN_CONTEXT", "already-consumed-context")
	t.Setenv("AGENTROOM_PI_FORBIDDEN_ARTIFACT", artifactAlias.LocalPath)
	terminal = Event{}
	if err := adapter.Execute(context.Background(), request, func(_ context.Context, event Event) error {
		if event.Status != nil {
			terminal = event
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Session == nil || terminal.Session.Disposition != contracts.Resumed ||
		terminal.Session.ContextCursor != 9 ||
		terminal.Session.RoomContextConsumption == nil ||
		terminal.Session.RoomContextConsumption.BaseContextCursor != 7 ||
		terminal.Session.RoomContextConsumption.CheckpointID != nil ||
		terminal.Session.RoomContextConsumption.RawMessageCount != 1 ||
		terminal.Session.RoomContextConsumption.CoverageThroughSequence != 9 {
		t.Fatalf("existing Pi Task Session was not resumed: %#v", terminal)
	}
	deliveryKind := contracts.Delta
	fromRevision := int64(4)
	throughRevision := int64(6)
	request.Run.RunID = "run_result_gap"
	request.Run.RoomContextBundle = nil
	request.Run.ContextPlan = &contracts.RuntimeContextPlan{
		ResultEvidence: &contracts.TaskResultEvidence{
			Revision: 6, DeliveryKind: &deliveryKind,
			FromRevision: &fromRevision, ThroughRevision: &throughRevision,
			ArtifactRefs: []contracts.ArtifactReference{{
				ArtifactID: artifactAlias.ArtifactID, Type: contracts.Commit,
				Content: &content,
			}},
		},
	}
	terminal = Event{}
	if err := adapter.Execute(context.Background(), request, func(_ context.Context, event Event) error {
		if event.Status != nil {
			terminal = event
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed ||
		terminal.Error == nil || terminal.Error.Code != "RESULT_EVIDENCE_CURSOR_GAP" ||
		terminal.Session != nil {
		t.Fatalf("Pi accepted discontinuous result evidence: %#v", terminal)
	}
	if afterGap, found, err := store.Load(plan.Key); err != nil || !found ||
		afterGap.ResultEvidenceRevision != 5 {
		t.Fatalf("Pi cursor advanced across gap: %#v found=%t err=%v", afterGap, found, err)
	}
	otherTaskID := "task_beta"
	request.Run.TaskID = &otherTaskID
	otherPlan, eligible, err := planRuntimeSession("pi", configuration, request.Run)
	if err != nil || !eligible || otherPlan.Key == plan.Key ||
		piSessionID(otherPlan.Key, request.Run.RunID) == expectedSessionID {
		t.Fatal("Pi native session identity crossed Task scope")
	}
}

func TestPiAmbiguousTimeoutDoesNotAdvanceRoomCoverage(t *testing.T) {
	t.Setenv("AGENTROOM_PI_HELPER", "hang")
	configuration := config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestPiHelperProcess"},
		Workspace: t.TempDir(), EnvAllowlist: []string{"AGENTROOM_PI_HELPER"},
		RuntimeKind: "pi", PresetVersion: config.CurrentPresetVersion,
	}
	store := NewFileRuntimeSessionStore(t.TempDir())
	adapter := PiAdapter{Config: configuration, Sessions: store}
	run := roomContextFixture()
	run.Deadline = time.Now().Add(150 * time.Millisecond)
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{Run: run}, func(_ context.Context, event Event) error {
		if event.Status != nil {
			terminal = event
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed ||
		terminal.Error == nil || terminal.Error.Code != "RUNTIME_TIMEOUT" ||
		terminal.Session != nil {
		t.Fatalf("ambiguous Pi timeout advanced coverage: %#v", terminal)
	}
	plan, eligible, err := planRuntimeSession("pi", configuration, run)
	if err != nil || !eligible {
		t.Fatalf("Pi coverage Session could not be planned: eligible=%t err=%v", eligible, err)
	}
	if binding, found, err := store.Load(plan.Key); err != nil || found {
		t.Fatalf("ambiguous Pi timeout persisted a cursor: %#v found=%t err=%v", binding, found, err)
	}
}

func TestInsertPiSessionArgumentsPrecedesOptionTerminator(t *testing.T) {
	arguments := insertPiSessionArguments(
		[]string{"--mode", "json", "--", "literal-message"},
		"--session-id", "session-id",
	)
	expected := []string{"--mode", "json", "--session-id", "session-id", "--", "literal-message"}
	if !slices.Equal(arguments, expected) {
		t.Fatalf("Pi session selector was not inserted before --: %#v", arguments)
	}
}

func TestPiHelperProcess(t *testing.T) {
	if os.Getenv("AGENTROOM_PI_HELPER") == "hang" {
		if _, err := io.ReadAll(os.Stdin); err != nil {
			os.Exit(2)
		}
		fmt.Println(`{"type":"session","version":3}`)
		_ = os.Stdout.Sync()
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}
	if os.Getenv("AGENTROOM_PI_HELPER") == "session" {
		expectedID := os.Getenv("AGENTROOM_PI_EXPECTED_SESSION_ID")
		expectedName := piSessionName(contracts.RunRequestedPayload{
			RoomID: "room_alpha", TargetAgentName: stringPointer("我的 Pi"),
		})
		if *piHelperSessionID != expectedID || *piHelperSessionName != expectedName {
			os.Exit(3)
		}
		prompt, err := io.ReadAll(os.Stdin)
		if err != nil ||
			(os.Getenv("AGENTROOM_PI_REQUIRED_CONTEXT") != "" &&
				!strings.Contains(string(prompt), os.Getenv("AGENTROOM_PI_REQUIRED_CONTEXT"))) ||
			(os.Getenv("AGENTROOM_PI_FORBIDDEN_CONTEXT") != "" &&
				strings.Contains(string(prompt), os.Getenv("AGENTROOM_PI_FORBIDDEN_CONTEXT"))) ||
			(os.Getenv("AGENTROOM_PI_FORBIDDEN_ARTIFACT") != "" &&
				strings.Contains(string(prompt), os.Getenv("AGENTROOM_PI_FORBIDDEN_ARTIFACT"))) {
			os.Exit(4)
		}
		fmt.Println(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Session resumed."}],"stopReason":"stop"}}`)
		os.Exit(0)
	}
	if os.Getenv("AGENTROOM_PI_HELPER") != "stream" {
		return
	}
	text := strings.Repeat("streaming ", 12)
	encoded, err := json.Marshal(text)
	if err != nil {
		os.Exit(2)
	}
	fmt.Println(`{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	fmt.Println(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":` + string(encoded) + `}}`)
	_ = os.Stdout.Sync()
	time.Sleep(200 * time.Millisecond)
	fmt.Println(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":` +
		string(encoded) + `}],"stopReason":"stop"}}`)
	os.Exit(0)
}

func stringPointer(value string) *string {
	return &value
}

func TestPiStreamParserBatchesTextAndResetsAfterToolUse(t *testing.T) {
	parser := &piStreamParser{}
	consumePiLine(t, parser, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	consumePiLine(t, parser, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"`+
		strings.Repeat("A", 80)+`"}}`)
	first, err := parser.outputDelta(false)
	if err != nil || first == nil || first.Reset || first.Content != strings.Repeat("A", 16) {
		t.Fatalf("unexpected first preview: %#v, %v", first, err)
	}
	consumePiLine(t, parser, `{"type":"message_end","message":{"role":"assistant","content":[`+
		`{"type":"text","text":"`+strings.Repeat("A", 80)+`"},{"type":"toolCall"}],"stopReason":"toolUse"}}`)
	consumePiLine(t, parser, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	consumePiLine(t, parser, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"`+
		strings.Repeat("B", 80)+`"}}`)
	second, err := parser.outputDelta(false)
	if err != nil || second == nil || !second.Reset || second.Content != strings.Repeat("B", 16) {
		t.Fatalf("unexpected reset preview: %#v, %v", second, err)
	}
}

func TestPiStreamParserWithholdsSplitSecretsAndAssessment(t *testing.T) {
	parser := &piStreamParser{}
	consumePiLine(t, parser, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	text := strings.Repeat("visible ", 12) + "token=very-sensitive-value" +
		strings.Repeat(" trailing", 12) + assessmentOpen + `{"goalSatisfied":true}` + assessmentClose
	consumePiLine(t, parser, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":`+
		quotedJSON(t, text)+`}}`)
	delta, err := parser.outputDelta(false)
	if err != nil || delta == nil {
		t.Fatalf("expected safe preview: %#v, %v", delta, err)
	}
	if strings.Contains(delta.Content, "very-sensitive") || strings.Contains(delta.Content, "agentroom-assessment") {
		t.Fatalf("private content escaped preview: %q", delta.Content)
	}
}

func TestPiAdapterRejectsProviderToolProtocolLeak(t *testing.T) {
	leaked := `I will inspect the repository.<]minimax[><tool_call>` +
		`<tool_name>bash</tool_name><parameters><command>ls</command></parameters></tool_call>`
	output := `{"type":"message_end","message":{"role":"assistant","content":[` +
		`{"type":"text","text":` + quotedJSON(t, leaked) + `}],"stopReason":"stop"}}`
	events := executePiFixture(t, output)
	if len(events) != 2 || events[1].Status == nil || *events[1].Status != contracts.Failed ||
		events[1].Error == nil || events[1].Error.Code != "RUNTIME_PROTOCOL_INVALID" ||
		events[1].Error.Details["category"] != "model" {
		t.Fatalf("unexpected Pi protocol failure: %#v", events)
	}
	for _, event := range events {
		if event.Reply != "" ||
			(event.Error != nil && strings.Contains(event.Error.Message, "minimax")) {
			t.Fatalf("provider protocol content escaped the adapter: %#v", events)
		}
	}
}

func TestPiAdapterRejectsMalformedOrMissingAssistantEvents(t *testing.T) {
	for name, output := range map[string]string{
		"malformed":    `{not-json}`,
		"no assistant": `{"type":"message_end","message":{"role":"user","content":[]}}`,
		"unfinished tool call": `{"type":"message_end","message":{"role":"assistant","content":[` +
			`{"type":"text","text":"I will inspect it."},{"type":"toolCall"}],"stopReason":"toolUse"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			events := executePiFixture(t, output)
			terminal := events[len(events)-1]
			if terminal.Status == nil || *terminal.Status != contracts.Failed ||
				terminal.Error == nil || terminal.Error.Code != "RUNTIME_PROTOCOL_INVALID" {
				t.Fatalf("unexpected terminal event: %#v", terminal)
			}
		})
	}
}

func executePiFixture(t *testing.T, output string) []Event {
	t.Helper()
	adapter := PiAdapter{Config: config.AgentConfig{
		Command: []string{"/usr/bin/printf", "%s", output}, Workspace: t.TempDir(),
	}}
	var events []Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}

func quotedJSON(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func consumePiLine(t *testing.T, parser *piStreamParser, line string) bool {
	t.Helper()
	final, err := parser.consume([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	return final
}
