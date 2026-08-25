package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const maxPiProtocolOutput = 512 * 1024
const piPreviewSafetyRunes = 64
const piPreviewFlushInterval = 75 * time.Millisecond

var errPiProtocolInvalid = errors.New("Pi returned an incompatible event stream")
var errPiOutputLimit = errors.New("Pi assistant output exceeded its safe limit")

// PiAdapter keeps Pi behind its documented JSON event boundary. Assistant text
// and the final reply cross as output; explicit thinking/reasoning summaries
// and tool name/lifecycle cross as activity. Usage, tool arguments/results,
// commands, paths, and provider-specific fragments remain local.
type PiAdapter struct {
	Config   config.AgentConfig
	Sessions RuntimeSessionStore
}

func (p PiAdapter) Name() string { return "pi" }

func (p PiAdapter) Capabilities() Capabilities {
	return Capabilities{SupportsResume: true, SupportsStreaming: true, SupportsInterrupt: true}
}

func (p PiAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
	promptRun := request.Run
	var sessionKey *RuntimeSessionKey
	var sessionBinding RuntimeSessionBinding
	logicalTaskSession := false
	sessionDisposition := contracts.Started
	nativeSessionID := ""
	plan, sessionEligible, planErr := planRuntimeSession("pi", p.Config, request.Run)
	if planErr != nil {
		return emitPiSessionFailure(ctx, emit)
	}
	if p.Config.RuntimeKind == "pi" &&
		p.Config.PresetVersion >= config.CurrentPresetVersion && sessionEligible {
		key := plan.Key
		found := false
		if p.Sessions != nil {
			binding, bindingFound, err := p.Sessions.Load(key)
			if err != nil {
				return emitPiSessionFailure(ctx, emit)
			}
			found = bindingFound
			sessionBinding = binding
			if found && plan.ResumePolicy == contracts.StartNew {
				if err := p.Sessions.Delete(key); err != nil {
					return emitPiSessionFailure(ctx, emit)
				}
				found = false
				sessionBinding = RuntimeSessionBinding{}
			}
		}
		if found {
			nativeSessionID = sessionBinding.SessionID
			sessionDisposition = contracts.Resumed
			if plan.LogicalTask {
				promptRun = contextDeltaForSession(request.Run, sessionBinding)
			}
		} else {
			nativeSessionID = piSessionID(key, request.Run.RunID)
		}
		logicalTaskSession = plan.LogicalTask
		sessionKey = &key
	}
	working := contracts.Working
	if err := emit(ctx, Event{Status: &working}); err != nil {
		return err
	}
	runContext := ctx
	cancelDeadline := func() {}
	if !request.Run.Deadline.IsZero() {
		runContext, cancelDeadline = context.WithDeadline(ctx, request.Run.Deadline)
	}
	defer cancelDeadline()
	processContext, cancelProcess := context.WithCancel(runContext)
	defer cancelProcess()
	commandArguments := append([]string(nil), p.Config.Command[1:]...)
	if nativeSessionID != "" {
		commandArguments = insertPiSessionArguments(
			commandArguments,
			"--session-id", nativeSessionID,
			"--name", piSessionName(request.Run),
		)
	}
	command := exec.CommandContext(processContext, p.Config.Command[0], commandArguments...)
	configureRuntimeCommand(command)
	command.Dir = p.Config.Workspace
	command.Env = allowedEnvironment(p.Config.EnvAllowlist)
	command.Stdin = strings.NewReader(runtimePrompt(promptRun))
	stdout, err := command.StdoutPipe()
	if err != nil {
		return emitPiStartFailure(ctx, emit)
	}
	stderr := &limitedBuffer{remaining: 4_096}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return emitPiStartFailure(ctx, emit)
	}

	type scanResult struct {
		line []byte
		err  error
		done bool
	}
	results := make(chan scanResult)
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64*1024), maxPiProtocolOutput)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case results <- scanResult{line: line}:
			case <-processContext.Done():
				return
			}
		}
		select {
		case results <- scanResult{err: scanner.Err(), done: true}:
		case <-processContext.Done():
		}
	}()

	parser := &piStreamParser{}
	ticker := time.NewTicker(piPreviewFlushInterval)
	defer ticker.Stop()
	total := 0
	var protocolError error
	var executionError error
	streamDone := false
	emitPreview := func(force bool) error {
		delta, previewError := parser.outputDelta(force)
		if previewError != nil {
			return previewError
		}
		if delta == nil {
			return nil
		}
		return emit(runContext, Event{Output: delta})
	}
	for !streamDone {
		select {
		case result := <-results:
			if result.done {
				streamDone = true
				if result.err != nil {
					protocolError = result.err
				}
				continue
			}
			total += len(result.line) + 1
			if total > maxPiProtocolOutput {
				protocolError = errPiOutputLimit
				streamDone = true
				cancelProcess()
				continue
			}
			finalAssistant, consumeError := parser.consume(result.line)
			if consumeError != nil {
				protocolError = consumeError
				streamDone = true
				cancelProcess()
				continue
			}
			for _, activity := range parser.drainActivities() {
				activityValue := activity
				if err := emit(runContext, Event{Activity: &activityValue}); err != nil {
					executionError = err
					streamDone = true
					cancelProcess()
					break
				}
			}
			if executionError != nil {
				continue
			}
			if finalAssistant {
				if err := emitPreview(true); err != nil {
					if errors.Is(err, errPiProtocolInvalid) || errors.Is(err, errPiOutputLimit) {
						protocolError = err
					} else {
						executionError = err
					}
					streamDone = true
					cancelProcess()
				}
			}
		case <-ticker.C:
			if err := emitPreview(false); err != nil {
				if errors.Is(err, errPiProtocolInvalid) || errors.Is(err, errPiOutputLimit) {
					protocolError = err
				} else {
					executionError = err
				}
				streamDone = true
				cancelProcess()
			}
		case <-runContext.Done():
			streamDone = true
			cancelProcess()
		}
	}
	waitError := command.Wait()
	if executionError != nil {
		return executionError
	}
	if runContext.Err() != nil {
		status := contracts.Canceled
		code := "RUNTIME_CANCELED"
		message := "Runtime execution was canceled."
		if errors.Is(runContext.Err(), context.DeadlineExceeded) {
			status = contracts.Failed
			code = "RUNTIME_TIMEOUT"
			message = "Runtime execution exceeded its deadline."
		}
		return emit(ctx, Event{Status: &status, Error: runtimeError(code, message)})
	}
	if errors.Is(protocolError, errPiOutputLimit) || errors.Is(stderr.err, errOutputLimit) {
		failed := contracts.Failed
		return emit(ctx, Event{Status: &failed, Error: runtimeError(
			"RUNTIME_OUTPUT_LIMIT", "Runtime output exceeded its safe limit.",
		)})
	}
	if protocolError != nil {
		return emitPiProtocolFailure(ctx, emit)
	}
	if waitError != nil {
		failed := contracts.Failed
		var exitError *exec.ExitError
		if !errors.As(waitError, &exitError) {
			return emitPiStartFailure(ctx, emit)
		}
		stderrText := stderr.String()
		return emit(ctx, Event{Status: &failed, Error: runtimeErrorWithDetails(
			"RUNTIME_EXIT_FAILED",
			"Runtime process exited unsuccessfully.",
			map[string]interface{}{
				"category": classifyRuntimeFailure(stderrText), "exitCode": exitError.ExitCode(),
				"stderrCaptured": strings.TrimSpace(stderrText) != "",
			},
		)})
	}
	reply := parser.finalReply
	if reply == "" || containsLeakedToolProtocol(reply) {
		return emitPiProtocolFailure(ctx, emit)
	}
	reply, assessment := parseAssessmentEnvelope(reply)
	if len([]byte(reply)) > maxRuntimeOutput {
		failed := contracts.Failed
		return emit(ctx, Event{Status: &failed, Error: runtimeError(
			"RUNTIME_OUTPUT_LIMIT", "Runtime reply exceeded its safe limit.",
		)})
	}
	var logicalStatus *contracts.LogicalSessionStatus
	if p.Sessions != nil && sessionKey != nil {
		now := time.Now().UTC()
		sessionBinding.RuntimeSessionKey = *sessionKey
		sessionBinding.SessionID = nativeSessionID
		if sessionBinding.CreatedAt.IsZero() {
			sessionBinding.CreatedAt = now
		}
		if logicalTaskSession && plan.ContextCursor > sessionBinding.LastRoomSequence {
			sessionBinding.LastRoomSequence = plan.ContextCursor
		}
		sessionBinding.LastRunID = request.Run.RunID
		roomMemoryRevision, taskMemoryRevision := contextMemoryRevisions(request.Run)
		if roomMemoryRevision > sessionBinding.RoomMemoryRevision {
			sessionBinding.RoomMemoryRevision = roomMemoryRevision
		}
		if taskMemoryRevision > sessionBinding.TaskMemoryRevision {
			sessionBinding.TaskMemoryRevision = taskMemoryRevision
		}
		sessionBinding.UpdatedAt = now
		if err := p.Sessions.Save(sessionBinding); err != nil {
			return emitPiSessionFailure(ctx, emit)
		}
		if logicalTaskSession {
			logicalStatus = sessionStatus(
				sessionDisposition,
				sessionBinding.LastRoomSequence,
			)
		}
	}
	if err := emit(ctx, Event{Reply: reply, Assessment: assessment}); err != nil {
		return err
	}
	completed := contracts.Completed
	return emit(ctx, Event{Status: &completed, Session: logicalStatus})
}

func insertPiSessionArguments(arguments []string, sessionArguments ...string) []string {
	for index, argument := range arguments {
		if argument == "--" {
			result := make([]string, 0, len(arguments)+len(sessionArguments))
			result = append(result, arguments[:index]...)
			result = append(result, sessionArguments...)
			return append(result, arguments[index:]...)
		}
	}
	return append(arguments, sessionArguments...)
}

func piSessionID(key RuntimeSessionKey, seed string) string {
	encoded, _ := json.Marshal(struct {
		Key  RuntimeSessionKey `json:"key"`
		Seed string            `json:"seed"`
	}{Key: key, Seed: seed})
	digest := sha256.Sum256(append([]byte("agentroom/pi/v2\x00"), encoded...))
	digest[6] = (digest[6] & 0x0f) | 0x50
	digest[8] = (digest[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%x-%x-%x-%x-%x",
		digest[0:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16],
	)
}

func emitPiSessionFailure(ctx context.Context, emit EmitFunc) error {
	failed := contracts.Failed
	return emit(ctx, Event{Status: &failed, Error: runtimeError(
		"RUNTIME_SESSION_STATE_INVALID",
		"Runtime session state could not be resolved or persisted.",
	)})
}

func piSessionName(run contracts.RunRequestedPayload) string {
	name := "Agent"
	if run.TargetAgentName != nil && strings.TrimSpace(*run.TargetAgentName) != "" {
		name = strings.Join(strings.Fields(*run.TargetAgentName), " ")
	}
	roomDigest := sha256.Sum256([]byte(run.RoomID))
	value := fmt.Sprintf("AgentRoom · %s · %x", name, roomDigest[:4])
	runes := []rune(value)
	if len(runes) > 120 {
		value = string(runes[:120])
	}
	return value
}

func emitPiStartFailure(ctx context.Context, emit EmitFunc) error {
	failed := contracts.Failed
	return emit(ctx, Event{Status: &failed, Error: runtimeErrorWithDetails(
		"RUNTIME_START_FAILED",
		"Runtime process could not be started.",
		map[string]interface{}{"category": "start"},
	)})
}

func emitPiProtocolFailure(ctx context.Context, emit EmitFunc) error {
	failed := contracts.Failed
	return emit(ctx, Event{
		Status: &failed,
		Error: runtimeErrorWithDetails(
			"RUNTIME_PROTOCOL_INVALID",
			"Pi returned an incompatible structured response.",
			map[string]interface{}{"category": "model"},
		),
	})
}

type piEvent struct {
	Type                  string                   `json:"type"`
	Message               *piMessage               `json:"message"`
	AssistantMessageEvent *piAssistantMessageEvent `json:"assistantMessageEvent"`
	ToolName              string                   `json:"toolName"`
	ToolCallID            string                   `json:"toolCallId"`
	IsError               bool                     `json:"isError"`
}

type piAssistantMessageEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
}

type piMessage struct {
	Role         string          `json:"role"`
	Content      []piContentPart `json:"content"`
	StopReason   string          `json:"stopReason"`
	ErrorMessage string          `json:"errorMessage"`
}

type piContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type piStreamParser struct {
	currentAssistant bool
	currentText      strings.Builder
	emittedText      string
	finalReply       string
	resetPending     bool
	resetNext        bool
	activities       []Activity
	reasoningID      string
	reasoningCounter int
	reasoningPreview *activityTextPreview
	toolID           string
	toolCounter      int
}

func (p *piStreamParser) drainActivities() []Activity {
	activities := p.activities
	p.activities = nil
	return activities
}

func (p *piStreamParser) consume(source []byte) (bool, error) {
	line := strings.TrimSpace(string(source))
	if line == "" {
		return false, nil
	}
	decoder := json.NewDecoder(strings.NewReader(line))
	var event piEvent
	if err := decoder.Decode(&event); err != nil {
		return false, errPiProtocolInvalid
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return false, errPiProtocolInvalid
	}
	switch event.Type {
	case "tool_execution_start":
		p.toolCounter++
		p.toolID = event.ToolCallID
		if p.toolID == "" || len(p.toolID) > 160 {
			p.toolID = fmt.Sprintf("pi-tool-%d", p.toolCounter)
		}
		label := strings.TrimSpace(event.ToolName)
		if label == "" {
			label = "Tool"
		}
		if len([]rune(label)) > 120 {
			label = string([]rune(label)[:120])
		}
		p.activities = append(p.activities, Activity{
			ID: p.toolID, Kind: "tool", Phase: "started", Label: label,
		})
	case "tool_execution_end":
		activityID := event.ToolCallID
		if activityID == "" || len(activityID) > 160 {
			activityID = p.toolID
		}
		if activityID == "" {
			p.toolCounter++
			activityID = fmt.Sprintf("pi-tool-%d", p.toolCounter)
		}
		label := strings.TrimSpace(event.ToolName)
		if label == "" {
			label = "Tool"
		}
		phase := "completed"
		if event.IsError {
			phase = "failed"
		}
		p.activities = append(p.activities, Activity{
			ID: activityID, Kind: "tool", Phase: phase, Label: label,
		})
		p.toolID = ""
	case "message_start":
		if event.Message == nil {
			return false, errPiProtocolInvalid
		}
		p.currentAssistant = event.Message.Role == "assistant"
		if p.currentAssistant {
			p.currentText.Reset()
			if p.resetNext {
				p.resetPending = true
				p.resetNext = false
			}
		}
	case "message_update":
		if event.AssistantMessageEvent == nil {
			return false, nil
		}
		if event.AssistantMessageEvent.Type == "thinking_delta" ||
			event.AssistantMessageEvent.Type == "reasoning_delta" {
			if !p.currentAssistant || event.AssistantMessageEvent.Delta == "" {
				return false, errPiProtocolInvalid
			}
			if p.reasoningID == "" {
				p.reasoningCounter++
				p.reasoningID = fmt.Sprintf("pi-reasoning-%d", p.reasoningCounter)
				p.reasoningPreview = &activityTextPreview{}
			}
			p.reasoningPreview.append(event.AssistantMessageEvent.Delta, false)
			p.activities = append(
				p.activities,
				p.reasoningPreview.project(p.reasoningID, "Thinking", false)...,
			)
			return false, nil
		}
		if event.AssistantMessageEvent.Type != "text_delta" {
			return false, nil
		}
		if !p.currentAssistant {
			return false, errPiProtocolInvalid
		}
		p.currentText.WriteString(event.AssistantMessageEvent.Delta)
	case "message_end":
		if event.Message == nil || event.Message.Role != "assistant" {
			return false, nil
		}
		if event.Message.StopReason == "error" || event.Message.StopReason == "aborted" ||
			strings.TrimSpace(event.Message.ErrorMessage) != "" {
			return false, errPiProtocolInvalid
		}
		if p.reasoningID != "" {
			if p.reasoningPreview != nil {
				p.activities = append(
					p.activities,
					p.reasoningPreview.project(p.reasoningID, "Thinking", true)...,
				)
			}
			p.activities = append(p.activities, Activity{
				ID: p.reasoningID, Kind: "reasoning", Phase: "completed", Label: "Thinking",
			})
			p.reasoningID = ""
			p.reasoningPreview = nil
		}
		var text strings.Builder
		hasToolCall := false
		for _, part := range event.Message.Content {
			if part.Type == "text" {
				text.WriteString(part.Text)
			}
			if part.Type == "toolCall" || part.Type == "tool_call" {
				hasToolCall = true
			}
		}
		candidate := strings.TrimSpace(text.String())
		p.currentText.Reset()
		p.currentText.WriteString(candidate)
		p.currentAssistant = false
		if hasToolCall || event.Message.StopReason == "toolUse" {
			p.finalReply = ""
			p.resetNext = p.emittedText != ""
			return false, nil
		}
		if candidate != "" {
			p.finalReply = candidate
			return true, nil
		}
	}
	return false, nil
}

func (p *piStreamParser) outputDelta(force bool) (*OutputDelta, error) {
	visible := p.currentText.String()
	if marker := strings.Index(visible, assessmentOpen); marker >= 0 {
		visible = strings.TrimSpace(visible[:marker])
	}
	if containsLeakedToolProtocol(visible) {
		return nil, errPiProtocolInvalid
	}
	if len([]byte(visible)) > maxRuntimeOutput {
		return nil, errPiOutputLimit
	}
	visible = RedactSensitiveText(visible)
	if !force {
		runes := []rune(visible)
		if len(runes) <= piPreviewSafetyRunes {
			visible = ""
		} else {
			visible = string(runes[:len(runes)-piPreviewSafetyRunes])
		}
	}
	if visible == p.emittedText {
		return nil, nil
	}
	if p.resetPending || !strings.HasPrefix(visible, p.emittedText) {
		if visible == "" {
			return nil, nil
		}
		p.emittedText = visible
		p.resetPending = false
		return &OutputDelta{Content: visible, Reset: true}, nil
	}
	delta := strings.TrimPrefix(visible, p.emittedText)
	if delta == "" {
		return nil, nil
	}
	if !utf8.ValidString(delta) {
		return nil, errPiProtocolInvalid
	}
	p.emittedText = visible
	return &OutputDelta{Content: delta}, nil
}

func parsePiEventStream(source string) (string, error) {
	parser := &piStreamParser{}
	scanner := bufio.NewScanner(strings.NewReader(source))
	scanner.Buffer(make([]byte, 64*1024), maxPiProtocolOutput)
	for scanner.Scan() {
		if _, err := parser.consume(scanner.Bytes()); err != nil {
			return "", err
		}
	}
	if scanner.Err() != nil || parser.finalReply == "" || containsLeakedToolProtocol(parser.finalReply) {
		return "", errPiProtocolInvalid
	}
	return parser.finalReply, nil
}

func containsLeakedToolProtocol(reply string) bool {
	normalized := strings.ToLower(reply)
	if strings.Contains(normalized, "<|tool_call") ||
		strings.Contains(normalized, "[tool_calls]") ||
		strings.Contains(normalized, "<]minimax[>") {
		return true
	}
	if !strings.Contains(normalized, "<tool_call") {
		return false
	}
	return strings.Contains(normalized, "<tool_name>") ||
		strings.Contains(normalized, "<parameters>") ||
		strings.Contains(normalized, "</tool_call>")
}
