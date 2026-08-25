package runtime

import (
	"bufio"
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

func TestCodexAdapterMapsAppServerEventsToRuntimeEvents(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "success")
	run, artifactAlias := artifactAliasFixture()
	run.Instruction = "implement it"
	t.Setenv("AGENTROOM_CODEX_REQUIRED_CONTEXT", artifactAlias.LocalPath)
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{
			"AGENTROOM_CODEX_HELPER", "AGENTROOM_CODEX_REQUIRED_CONTEXT",
		},
	}}
	var events []Event
	if err := adapter.Execute(context.Background(), Request{
		Run: run, Artifacts: []VerifiedArtifactAlias{artifactAlias},
	}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(events) != 8 || events[1].Activity == nil ||
		events[1].Activity.Kind != "reasoning" || events[1].Activity.Content != "Reviewing the task." ||
		events[2].Activity == nil || events[2].Activity.Phase != "completed" ||
		events[3].Activity == nil || events[3].Activity.Kind != "tool" ||
		events[3].Activity.Label != "Command" || events[4].Activity == nil ||
		events[4].Activity.Phase != "completed" || events[5].Output == nil ||
		events[5].Output.Content != "Implemented." || events[6].Reply != "Implemented." ||
		events[6].Assessment == nil || events[6].Assessment.GoalSatisfied == nil ||
		!*events[6].Assessment.GoalSatisfied || *events[7].Status != contracts.Completed {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestCodexTaskSessionRejectsResultEvidenceCursorGapBeforeRuntime(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "resume")
	configuration := config.AgentConfig{
		Command: []string{
			os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://",
		},
		Workspace: t.TempDir(), Sandbox: "workspace-write",
		EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
		RuntimeKind:  "codex", Adapter: "codex",
	}
	store := NewFileRuntimeSessionStore(t.TempDir())
	taskID := "task_result_gap"
	key := testRuntimeSessionKey(t, configuration, taskID)
	if err := store.Save(RuntimeSessionBinding{
		RuntimeSessionKey: key, SessionID: "019d-thread",
		ResultEvidenceRevision: 5,
	}); err != nil {
		t.Fatal(err)
	}
	deliveryKind := contracts.Delta
	fromRevision := int64(4)
	throughRevision := int64(6)
	run, artifactAlias := artifactAliasFixture()
	run.RunID = "run_codex_result_gap"
	run.RoomID = "room_codex_result_gap"
	run.TaskID = &taskID
	run.TargetAgentID = "agent_codex_result_gap"
	run.Instruction = "continue after accepted evidence"
	run.Session = &contracts.LogicalSessionRequest{
		Scope: contracts.Task, ResumePolicy: contracts.ResumeOrStart,
		ContextCursor: 1,
	}
	run.ContextPlan.ResultEvidence.Revision = 6
	run.ContextPlan.ResultEvidence.DeliveryKind = &deliveryKind
	run.ContextPlan.ResultEvidence.FromRevision = &fromRevision
	run.ContextPlan.ResultEvidence.ThroughRevision = &throughRevision
	adapter := CodexAdapter{Config: configuration, Sessions: store}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{
		Run: run, Artifacts: []VerifiedArtifactAlias{artifactAlias},
	}, func(_ context.Context, event Event) error {
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
		t.Fatalf("Codex accepted discontinuous result evidence: %#v", terminal)
	}
	if binding, found, err := store.Load(key); err != nil || !found ||
		binding.ResultEvidenceRevision != 5 {
		t.Fatalf("Codex cursor advanced across gap: %#v found=%t err=%v", binding, found, err)
	}
}

func TestCodexAdapterResumesStoredTaskAgentThread(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "resume")
	workspace := t.TempDir()
	store := NewFileRuntimeSessionStore(t.TempDir())
	configuration := config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: workspace, Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
		RuntimeKind: "codex", Adapter: "codex",
	}
	key := testRuntimeSessionKey(t, configuration, "task_alpha")
	if err := store.Save(RuntimeSessionBinding{
		RuntimeSessionKey: key, SessionID: "019d-thread", LastRoomSequence: 41,
		ResultEvidenceRevision: 5,
	}); err != nil {
		t.Fatal(err)
	}
	adapter := CodexAdapter{Config: configuration, Sessions: store}
	var terminal Event
	taskID := "task_alpha"
	run := roomContextFixture()
	run.RoomID = "room_alpha"
	run.TargetAgentID = "agent_builder"
	run.TaskID = &taskID
	run.Instruction = "implement it"
	run.RunID = "run_next"
	run.Session.ContextCursor = 42
	run.RoomContextBundle.TargetThroughSequence = 42
	run.RoomContextBundle.PriorContextThroughSequence = 41
	run.RoomContextBundle.RawTail.Messages = run.RoomContextBundle.RawTail.Messages[:1]
	run.RoomContextBundle.RawTail.ThroughSequenceInclusive = 41
	run.RoomContextBundle.RawTail.MessageCount = 1
	run.RoomContextBundle.RawTail.Utf8Bytes = int64(len("message forty-one"))
	deliveryKind := contracts.Delta
	fromRevision := int64(5)
	throughRevision := int64(6)
	run.ContextPlan = &contracts.RuntimeContextPlan{
		ResultEvidence: &contracts.TaskResultEvidence{
			Revision: 6, DeliveryKind: &deliveryKind,
			FromRevision: &fromRevision, ThroughRevision: &throughRevision,
			ArtifactRefs: []contracts.ArtifactReference{{
				ArtifactID: "artifact_codex_cursor_12345678", Type: contracts.Commit,
				Title: "accepted evidence", Summary: "continue after revision five",
			}},
		},
	}
	if err := adapter.Execute(context.Background(), Request{Run: run}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Completed ||
		terminal.Session == nil || terminal.Session.Disposition != contracts.Resumed ||
		terminal.Session.ContextCursor != 42 ||
		terminal.Session.RoomContextConsumption == nil ||
		terminal.Session.RoomContextConsumption.BaseContextCursor != 41 ||
		terminal.Session.RoomContextConsumption.CheckpointID != nil ||
		terminal.Session.RoomContextConsumption.RawMessageCount != 0 ||
		terminal.Session.RoomContextConsumption.CoverageThroughSequence != 42 ||
		terminal.Session.ResultEvidenceRevision == nil ||
		*terminal.Session.ResultEvidenceRevision != 6 {
		t.Fatalf("stored Codex thread did not resume: %#v", terminal)
	}
	binding, found, err := store.Load(key)
	if err != nil || !found || binding.ResultEvidenceRevision != 6 {
		t.Fatalf("Codex did not persist accepted result evidence cursor: %#v found=%t err=%v", binding, found, err)
	}
}

func TestCodexAppServerParserStreamsAndResetsAcrossAgentMessages(t *testing.T) {
	parser := newCodexAppServerParser(config.AgentConfig{
		Workspace: t.TempDir(), Sandbox: "workspace-write",
	}, "implement it")
	consumeCodexFixture(t, parser, `{"id":1,"result":{"userAgent":"fixture"}}`)
	consumeCodexFixture(t, parser, `{"id":2,"result":{"thread":{"id":"thread-1"}}}`)
	consumeCodexFixture(t, parser, `{"id":3,"result":{"turn":{"id":"turn-1"}}}`)

	first := consumeCodexFixture(t, parser, `{"method":"item/agentMessage/delta","params":{`+
		`"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"`+
		strings.Repeat("A", 80)+`"}}`)
	if first == nil || first.Reset || first.Content != strings.Repeat("A", 16) {
		t.Fatalf("unexpected first Codex preview: %#v", first)
	}
	second := consumeCodexFixture(t, parser, `{"method":"item/agentMessage/delta","params":{`+
		`"threadId":"thread-1","turnId":"turn-1","itemId":"item-2","delta":"`+
		strings.Repeat("B", 80)+`"}}`)
	if second == nil || !second.Reset || second.Content != strings.Repeat("B", 16) {
		t.Fatalf("unexpected reset Codex preview: %#v", second)
	}
}

func TestCodexAppServerParserResumesAndReplacesMissingThread(t *testing.T) {
	store := NewFileRuntimeSessionStore(t.TempDir())
	workspace := t.TempDir()
	configuration := config.AgentConfig{
		RuntimeKind: "codex", Adapter: "codex", Workspace: workspace,
		Command: []string{"codex", "app-server"}, Sandbox: "workspace-write",
	}
	key := testRuntimeSessionKey(t, configuration, "task_alpha")
	if err := store.Save(RuntimeSessionBinding{RuntimeSessionKey: key, SessionID: "thread-old"}); err != nil {
		t.Fatal(err)
	}
	binding, found, err := store.Load(key)
	if err != nil || !found {
		t.Fatal("stored binding could not be loaded")
	}
	parser := newCodexAppServerSessionParser(
		configuration, "continue it", store, &key, "thread-old",
	)
	parser.binding = binding
	parser.logicalTaskSession = true
	parser.sessionDisposition = contracts.Resumed
	parser.bootstrapInstruction = "full recreated Task bootstrap"
	parser.contextCursor = 43
	parser.runID = "run_recreated"
	_, messages, err := parser.consume([]byte(`{"id":1,"result":{"userAgent":"fixture"}}`))
	if err != nil || len(messages) != 2 || !strings.Contains(fmt.Sprint(messages[1]), "thread/resume") ||
		!strings.Contains(fmt.Sprint(messages[1]), "thread-old") {
		t.Fatalf("Codex did not resume the stored thread: %#v, %v", messages, err)
	}
	_, messages, err = parser.consume([]byte(`{"id":2,"error":{"code":-32001,"message":"not found"}}`))
	if err != nil || len(messages) != 1 || !strings.Contains(fmt.Sprint(messages[0]), "thread/start") ||
		strings.Contains(fmt.Sprint(messages[0]), "ephemeral") {
		t.Fatalf("Codex did not replace the missing thread: %#v, %v", messages, err)
	}
	if _, found, err := store.Load(key); err != nil || found {
		t.Fatalf("stale Codex binding remained: found=%t err=%v", found, err)
	}
	if parser.instruction != "full recreated Task bootstrap" {
		t.Fatalf("recreated Codex Thread retained a resume delta: %q", parser.instruction)
	}
	consumeCodexFixture(t, parser, `{"id":2,"result":{"thread":{"id":"thread-new","ephemeral":false}}}`)
	binding, found, err = store.Load(key)
	if err != nil || !found || binding.SessionID != "thread-new" {
		t.Fatalf("replacement Codex thread was not persisted: %#v found=%t err=%v", binding, found, err)
	}
	consumeCodexFixture(t, parser, `{"id":3,"result":{"turn":{"id":"turn-new"}}}`)
	if status := parser.logicalSessionStatus(); status == nil ||
		status.Disposition != contracts.Recreated || status.ContextCursor != 43 {
		t.Fatalf("replacement Codex disposition was not reported: %#v", status)
	}
}

func TestCodexAppServerParserWithholdsSecretsAndRejectsInteractiveRequests(t *testing.T) {
	parser := newCodexAppServerParser(config.AgentConfig{
		Workspace: t.TempDir(), Sandbox: "read-only",
	}, "inspect it")
	consumeCodexFixture(t, parser, `{"id":1,"result":{"userAgent":"fixture"}}`)
	consumeCodexFixture(t, parser, `{"id":2,"result":{"thread":{"id":"thread-1"}}}`)
	consumeCodexFixture(t, parser, `{"id":3,"result":{"turn":{"id":"turn-1"}}}`)
	secret := strings.Repeat("visible ", 12) + "token=very-sensitive-value" + strings.Repeat(" trailing", 12)
	delta := consumeCodexFixture(t, parser, `{"method":"item/agentMessage/delta","params":{`+
		`"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":`+quotedJSON(t, secret)+`}}`)
	if delta == nil || strings.Contains(delta.Content, "very-sensitive") {
		t.Fatalf("secret escaped Codex preview: %#v", delta)
	}
	_, responses, err := parser.consume([]byte(`{"id":41,"method":"item/commandExecution/requestApproval","params":{}}`))
	if err != nil || len(responses) != 1 || !strings.Contains(fmt.Sprint(responses[0]), "cannot answer interactive") {
		t.Fatalf("interactive Codex request was not rejected safely: %#v, %v", responses, err)
	}
}

func consumeCodexFixture(t *testing.T, parser *codexAppServerParser, source string) *OutputDelta {
	t.Helper()
	delta, _, err := parser.consume([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	return delta
}

func TestCodexAdapterRejectsIncompatibleAppServerStream(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "malformed")
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed || terminal.Error.Code != "CODEX_PROTOCOL_INVALID" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
}

func TestCodexAdapterTerminatesAppServerAtDeadline(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "hang")
	t.Setenv("AGENTROOM_CODEX_COVERAGE_PROMPT", "1")
	configuration := config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write",
		EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER", "AGENTROOM_CODEX_COVERAGE_PROMPT"},
		RuntimeKind:  "codex", Adapter: "codex",
	}
	store := NewFileRuntimeSessionStore(t.TempDir())
	adapter := CodexAdapter{Config: configuration, Sessions: store}
	var terminal Event
	run := roomContextFixture()
	run.Instruction = "wait"
	run.Deadline = time.Now().Add(150 * time.Millisecond)
	if err := adapter.Execute(context.Background(), Request{Run: run}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed ||
		terminal.Error == nil || terminal.Error.Code != "CODEX_TIMEOUT" ||
		terminal.Session == nil || terminal.Session.RoomContextConsumption == nil ||
		terminal.Session.RoomContextConsumption.CoverageThroughSequence != 43 {
		t.Fatalf("unexpected Codex deadline result: %#v error=%#v", terminal, terminal.Error)
	}
	plan, eligible, err := planRuntimeSession("codex", configuration, run)
	if err != nil || !eligible {
		t.Fatalf("coverage Session could not be planned: eligible=%t err=%v", eligible, err)
	}
	binding, found, err := store.Load(plan.Key)
	if err != nil || !found || binding.LastRoomSequence != 43 ||
		binding.LastRunID != run.RunID {
		t.Fatalf("accepted timeout did not retain its consumption cursor: %#v found=%t err=%v", binding, found, err)
	}
}

func TestCodexAdapterRejectsUnsafeConfiguration(t *testing.T) {
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{"codex", "app-server", "--dangerously-bypass-approvals-and-sandbox"},
		Workspace: t.TempDir(), Sandbox: "workspace-write",
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Error == nil || terminal.Error.Code != "CODEX_COMMAND_INVALID" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
}

func TestCodexAdapterClassifiesExitWithoutLeakingStderr(t *testing.T) {
	const seededSecret = "seeded-codex-secret"
	t.Setenv("AGENTROOM_CODEX_HELPER", "failure:"+seededSecret)
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Error == nil || terminal.Error.Code != "CODEX_EXIT_FAILED" ||
		terminal.Error.Details["exitCode"] != 23 ||
		terminal.Error.Details["category"] != "configuration" ||
		terminal.Error.Details["stderrCaptured"] != true || terminal.Session != nil {
		t.Fatalf("unexpected safe Codex failure: %#v", terminal)
	}
	encoded, err := json.Marshal(terminal.Error)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), seededSecret) {
		t.Fatalf("Codex stderr leaked through protocol error: %s", encoded)
	}
}

func TestCodexHelperProcess(t *testing.T) {
	switch os.Getenv("AGENTROOM_CODEX_HELPER") {
	case "success":
		runCodexAppServerFixture(t, true, "thread/start", true)
		return
	case "resume":
		runCodexAppServerFixture(t, true, "thread/resume", false)
		return
	case "hang":
		runCodexAppServerFixture(
			t,
			false,
			"thread/start",
			os.Getenv("AGENTROOM_CODEX_COVERAGE_PROMPT") != "1",
		)
		return
	case "malformed":
		fmt.Println(`not-json`)
		os.Exit(0)
	default:
		if strings.HasPrefix(os.Getenv("AGENTROOM_CODEX_HELPER"), "failure:") {
			fmt.Fprintln(os.Stderr, "EPERM operation not permitted: "+os.Getenv("AGENTROOM_CODEX_HELPER"))
			os.Exit(23)
		}
	}
}

func runCodexAppServerFixture(t *testing.T, complete bool, expectedOpen string, expectedEphemeral bool) {
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		switch request.ID {
		case 1:
			_ = encoder.Encode(map[string]any{"id": 1, "result": map[string]any{"userAgent": "fixture"}})
		case 2:
			var params struct {
				Cwd            string `json:"cwd"`
				Sandbox        string `json:"sandbox"`
				ApprovalPolicy string `json:"approvalPolicy"`
				Ephemeral      bool   `json:"ephemeral"`
				ThreadID       string `json:"threadId"`
			}
			if request.Method != expectedOpen || json.Unmarshal(request.Params, &params) != nil ||
				params.Cwd == "" || params.Sandbox != "workspace-write" ||
				params.ApprovalPolicy != "never" || params.Ephemeral != expectedEphemeral {
				os.Exit(3)
			}
			if expectedOpen == "thread/resume" && params.ThreadID != "019d-thread" {
				os.Exit(3)
			}
			_ = encoder.Encode(map[string]any{"id": 2, "result": map[string]any{
				"thread": map[string]any{"id": "019d-thread"},
			}})
		case 3:
			var params struct {
				ThreadID string `json:"threadId"`
				Input    []struct {
					Text string `json:"text"`
				} `json:"input"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.ThreadID != "019d-thread" {
				os.Exit(4)
			}
			expectedInput := "implement it"
			if !complete {
				expectedInput = "wait"
			}
			validInput := len(params.Input) == 1 && params.Input[0].Text == expectedInput
			if os.Getenv("AGENTROOM_CODEX_REQUIRED_CONTEXT") != "" && len(params.Input) == 1 {
				validInput = strings.Contains(params.Input[0].Text, "Current request:\n"+expectedInput) &&
					strings.Contains(params.Input[0].Text, os.Getenv("AGENTROOM_CODEX_REQUIRED_CONTEXT"))
			}
			if os.Getenv("AGENTROOM_CODEX_COVERAGE_PROMPT") == "1" && len(params.Input) == 1 {
				validInput = strings.Contains(params.Input[0].Text, "Current request:\n"+expectedInput) &&
					strings.Contains(params.Input[0].Text, "Rolling Room context checkpoint")
			}
			if expectedOpen == "thread/resume" && len(params.Input) == 1 {
				validInput = strings.Contains(params.Input[0].Text, "Current request:\n"+expectedInput) &&
					strings.Contains(params.Input[0].Text, "permission approval") &&
					!strings.Contains(params.Input[0].Text, "do not inject this twice")
			}
			if !validInput {
				os.Exit(4)
			}
			_ = encoder.Encode(map[string]any{"id": 3, "result": map[string]any{
				"turn": map[string]any{"id": "turn-1", "status": "inProgress"},
			}})
			if !complete {
				continue
			}
			_ = encoder.Encode(map[string]any{"method": "item/reasoning/summaryTextDelta", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1", "itemId": "reasoning-1",
				"summaryIndex": 0, "delta": "Reviewing the task.",
			}})
			_ = encoder.Encode(map[string]any{"method": "item/completed", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1",
				"item": map[string]any{"id": "reasoning-1", "type": "reasoning"},
			}})
			_ = encoder.Encode(map[string]any{"method": "item/started", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1",
				"item": map[string]any{"id": "command-1", "type": "commandExecution", "status": "inProgress"},
			}})
			_ = encoder.Encode(map[string]any{"method": "item/completed", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1",
				"item": map[string]any{"id": "command-1", "type": "commandExecution", "status": "completed"},
			}})
			_ = encoder.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1", "itemId": "item-1", "delta": "Implemented.",
			}})
			_ = encoder.Encode(map[string]any{"method": "item/completed", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1", "completedAtMs": 1,
				"item": map[string]any{"id": "item-1", "type": "agentMessage", "text": "Implemented.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>"},
			}})
			_ = encoder.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{
				"threadId": "019d-thread", "turn": map[string]any{"id": "turn-1", "status": "completed", "items": []any{}},
			}})
		}
	}
}
