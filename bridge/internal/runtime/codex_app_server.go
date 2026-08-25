package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"unicode/utf8"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const maxCodexProtocolOutput = 4 * 1024 * 1024
const codexPreviewSafetyRunes = 64

func (c CodexAdapter) executeAppServer(ctx context.Context, request Request, emit EmitFunc) error {
	working := contracts.Working
	if err := emit(ctx, Event{Status: &working}); err != nil {
		return err
	}
	if err := validateCodexCommand(c.Config.Command); err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_COMMAND_INVALID", err.Error())
	}
	var sessionKey *RuntimeSessionKey
	resumeThreadID := ""
	if c.Sessions != nil && request.Run.RoomID != "" && request.Run.TargetAgentID != "" {
		key := RuntimeSessionKey{
			RuntimeKind: "codex",
			RoomID:      request.Run.RoomID,
			AgentID:     request.Run.TargetAgentID,
			Workspace:   c.Config.Workspace,
		}
		binding, found, err := c.Sessions.Load(key)
		if err != nil {
			return emitCodexFailure(ctx, emit, "CODEX_SESSION_STATE_INVALID", "Codex session state could not be loaded.")
		}
		if found {
			resumeThreadID = binding.SessionID
		}
		sessionKey = &key
	}

	runContext := ctx
	cancelDeadline := func() {}
	if !request.Run.Deadline.IsZero() {
		runContext, cancelDeadline = context.WithDeadline(ctx, request.Run.Deadline)
	}
	defer cancelDeadline()
	processContext, cancelProcess := context.WithCancel(runContext)
	defer cancelProcess()

	command := exec.CommandContext(processContext, c.Config.Command[0], c.Config.Command[1:]...)
	configureRuntimeCommand(command)
	command.Dir = c.Config.Workspace
	command.Env = allowedEnvironment(c.Config.EnvAllowlist)
	stdin, err := command.StdinPipe()
	if err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex stdin could not be opened.")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex stdout could not be opened.")
	}
	stderr := &limitedBuffer{remaining: 8_192}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex process could not be started.")
	}

	writer := json.NewEncoder(stdin)
	write := func(message any) error {
		if err := writer.Encode(message); err != nil {
			return fmt.Errorf("write Codex app-server request: %w", err)
		}
		return nil
	}
	if err := write(map[string]any{
		"id": 1, "method": "initialize",
		"params": map[string]any{"clientInfo": map[string]string{
			"name": "agentroom_bridge", "title": "AgentRoom Bridge", "version": "0.2",
		}},
	}); err != nil {
		cancelProcess()
		_ = command.Wait()
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex initialization could not be sent.")
	}

	parser := newCodexAppServerSessionParser(
		c.Config, runtimePrompt(request.Run), c.Sessions, sessionKey, resumeThreadID,
	)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxCodexProtocolOutput)
	total := 0
	var protocolError error
	var executionError error
	for scanner.Scan() {
		total += len(scanner.Bytes()) + 1
		if total > maxCodexProtocolOutput {
			protocolError = fmt.Errorf("Codex app-server output exceeded limit")
			break
		}
		delta, messages, consumeError := parser.consume(scanner.Bytes())
		if consumeError != nil {
			protocolError = consumeError
			break
		}
		for _, message := range messages {
			if err := write(message); err != nil {
				protocolError = err
				break
			}
		}
		if protocolError != nil {
			break
		}
		for _, activity := range parser.drainActivities() {
			activityValue := activity
			if err := emit(runContext, Event{Activity: &activityValue}); err != nil {
				executionError = err
				break
			}
		}
		if executionError != nil {
			break
		}
		if delta != nil {
			if err := emit(runContext, Event{Output: delta}); err != nil {
				executionError = err
				break
			}
		}
		if parser.complete {
			break
		}
	}
	if scanner.Err() != nil && protocolError == nil && !parser.complete {
		protocolError = scanner.Err()
	}
	cancelProcess()
	waitError := command.Wait()
	if executionError != nil {
		return executionError
	}
	if runContext.Err() != nil {
		status := contracts.Canceled
		code := "CODEX_CANCELED"
		message := "Codex execution was canceled."
		if errors.Is(runContext.Err(), context.DeadlineExceeded) {
			status = contracts.Failed
			code = "CODEX_TIMEOUT"
			message = "Codex execution exceeded its deadline."
		}
		return emit(ctx, Event{Status: &status, Error: runtimeError(code, message)})
	}
	if protocolError != nil {
		return emitCodexFailure(ctx, emit, "CODEX_PROTOCOL_INVALID", "Codex emitted an incompatible app-server event stream.")
	}
	if !parser.complete {
		if waitError != nil {
			exitCode := -1
			var exitError *exec.ExitError
			if errors.As(waitError, &exitError) {
				exitCode = exitError.ExitCode()
			}
			stderrText := stderr.String()
			return emitCodexFailureWithDetails(ctx, emit, "CODEX_EXIT_FAILED", "Codex process exited unsuccessfully.", map[string]interface{}{
				"category": classifyRuntimeFailure(stderrText), "exitCode": exitCode,
				"stderrCaptured": strings.TrimSpace(stderrText) != "",
			})
		}
		return emitCodexFailure(ctx, emit, "CODEX_OUTCOME_UNKNOWN", "Codex exited without a complete turn envelope.")
	}
	if parser.failure != "" {
		return emitCodexFailure(ctx, emit, "CODEX_TURN_FAILED", "Codex reported an unsuccessful turn.")
	}
	if parser.reply == "" {
		return emitCodexFailure(ctx, emit, "CODEX_OUTCOME_UNKNOWN", "Codex completed without an assistant reply.")
	}
	if len([]byte(parser.reply)) > maxRuntimeOutput {
		return emitCodexFailure(ctx, emit, "CODEX_REPLY_LIMIT", "Codex reply exceeded 20000 bytes.")
	}
	reply, assessment := parseAssessmentEnvelope(parser.reply)
	if reply != "" {
		if err := emit(ctx, Event{Reply: reply, Assessment: assessment}); err != nil {
			return err
		}
	}
	completed := contracts.Completed
	return emit(ctx, Event{Status: &completed})
}

type codexAppServerMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type codexAppServerParser struct {
	config       config.AgentConfig
	instruction  string
	sessions     RuntimeSessionStore
	sessionKey   *RuntimeSessionKey
	resumeID     string
	resumeFailed bool
	threadID     string
	turnID       string
	currentItem  string
	currentText  strings.Builder
	emittedText  string
	reply        string
	resetPending bool
	complete     bool
	failure      string
	activities   []Activity
	reasoning    map[string]*activityTextPreview
}

func (p *codexAppServerParser) drainActivities() []Activity {
	activities := p.activities
	p.activities = nil
	return activities
}

func newCodexAppServerParser(configuration config.AgentConfig, instruction string) *codexAppServerParser {
	return newCodexAppServerSessionParser(configuration, instruction, nil, nil, "")
}

func newCodexAppServerSessionParser(
	configuration config.AgentConfig,
	instruction string,
	sessions RuntimeSessionStore,
	sessionKey *RuntimeSessionKey,
	resumeID string,
) *codexAppServerParser {
	return &codexAppServerParser{
		config: configuration, instruction: instruction, sessions: sessions,
		sessionKey: sessionKey, resumeID: resumeID,
		reasoning: make(map[string]*activityTextPreview),
	}
}

func (p *codexAppServerParser) consume(source []byte) (*OutputDelta, []any, error) {
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(string(source))))
	var message codexAppServerMessage
	if err := decoder.Decode(&message); err != nil {
		return nil, nil, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, nil, fmt.Errorf("Codex app-server emitted trailing JSON")
	}
	if len(message.ID) > 0 && message.Method != "" {
		var requestID any
		if err := json.Unmarshal(message.ID, &requestID); err != nil {
			return nil, nil, fmt.Errorf("Codex app-server request id is malformed")
		}
		return nil, []any{map[string]any{
			"id": requestID,
			"error": map[string]any{
				"code": -32601, "message": "AgentRoom Bridge cannot answer interactive Codex requests",
			},
		}}, nil
	}
	if len(message.ID) > 0 {
		return p.consumeResponse(message)
	}
	if message.Method == "" {
		return nil, nil, fmt.Errorf("Codex app-server message omitted method and id")
	}
	return p.consumeNotification(message.Method, message.Params)
}

func (p *codexAppServerParser) consumeResponse(message codexAppServerMessage) (*OutputDelta, []any, error) {
	if message.Error != nil {
		if string(message.ID) == "2" && p.resumeID != "" && !p.resumeFailed {
			if p.sessions != nil && p.sessionKey != nil {
				if err := p.sessions.Delete(*p.sessionKey); err != nil {
					return nil, nil, err
				}
			}
			p.resumeID = ""
			p.resumeFailed = true
			return nil, []any{p.threadRequest()}, nil
		}
		return nil, nil, fmt.Errorf("Codex app-server request failed: %s", message.Error.Message)
	}
	switch string(message.ID) {
	case "1":
		if len(message.Result) == 0 {
			return nil, nil, fmt.Errorf("Codex initialize response omitted result")
		}
		return nil, []any{
			map[string]any{"method": "initialized", "params": map[string]any{}},
			p.threadRequest(),
		}, nil
	case "2":
		var result struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if err := json.Unmarshal(message.Result, &result); err != nil || result.Thread.ID == "" {
			return nil, nil, fmt.Errorf("Codex thread open response omitted thread id")
		}
		p.threadID = result.Thread.ID
		if p.sessions != nil && p.sessionKey != nil {
			if err := p.sessions.Save(RuntimeSessionBinding{
				RuntimeSessionKey: *p.sessionKey,
				SessionID:         p.threadID,
			}); err != nil {
				return nil, nil, err
			}
		}
		return nil, []any{map[string]any{
			"id": 3, "method": "turn/start",
			"params": map[string]any{
				"threadId": p.threadID,
				"input":    []map[string]string{{"type": "text", "text": p.instruction}},
			},
		}}, nil
	case "3":
		var result struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if err := json.Unmarshal(message.Result, &result); err != nil || result.Turn.ID == "" {
			return nil, nil, fmt.Errorf("Codex turn/start response omitted turn id")
		}
		p.turnID = result.Turn.ID
		return nil, nil, nil
	default:
		return nil, nil, nil
	}
}

func (p *codexAppServerParser) threadRequest() map[string]any {
	sandbox := p.config.Sandbox
	if sandbox == "" {
		sandbox = "workspace-write"
	}
	params := map[string]any{
		"cwd": p.config.Workspace, "sandbox": sandbox, "approvalPolicy": "never",
	}
	method := "thread/start"
	if p.resumeID != "" {
		method = "thread/resume"
		params["threadId"] = p.resumeID
	} else if p.sessionKey == nil {
		params["ephemeral"] = true
	}
	return map[string]any{"id": 2, "method": method, "params": params}
}

func (p *codexAppServerParser) consumeNotification(method string, params json.RawMessage) (*OutputDelta, []any, error) {
	switch method {
	case "item/reasoning/summaryTextDelta":
		var value struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			ItemID   string `json:"itemId"`
			Delta    string `json:"delta"`
		}
		if err := json.Unmarshal(params, &value); err != nil || value.ItemID == "" || value.Delta == "" {
			return nil, nil, fmt.Errorf("Codex reasoning summary delta is malformed")
		}
		if value.ThreadID != p.threadID || (p.turnID != "" && value.TurnID != p.turnID) {
			return nil, nil, nil
		}
		preview := p.reasoning[value.ItemID]
		if preview == nil {
			preview = &activityTextPreview{}
			p.reasoning[value.ItemID] = preview
		}
		preview.append(value.Delta, false)
		p.activities = append(p.activities, preview.project(value.ItemID, "Thinking", false)...)
		return nil, nil, nil
	case "item/started":
		if err := p.consumeActivityItem(params, "started"); err != nil {
			return nil, nil, err
		}
		return nil, nil, nil
	case "item/agentMessage/delta":
		var value struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			ItemID   string `json:"itemId"`
			Delta    string `json:"delta"`
		}
		if err := json.Unmarshal(params, &value); err != nil || value.ThreadID == "" || value.TurnID == "" || value.ItemID == "" {
			return nil, nil, fmt.Errorf("Codex assistant delta is malformed")
		}
		if p.threadID != "" && value.ThreadID != p.threadID {
			return nil, nil, nil
		}
		if p.turnID != "" && value.TurnID != p.turnID {
			return nil, nil, nil
		}
		if p.currentItem != "" && p.currentItem != value.ItemID {
			p.currentText.Reset()
			p.resetPending = p.emittedText != ""
		}
		p.currentItem = value.ItemID
		p.currentText.WriteString(value.Delta)
		delta, err := p.outputDelta(false)
		return delta, nil, err
	case "item/completed":
		if err := p.consumeActivityItem(params, "completed"); err != nil {
			return nil, nil, err
		}
		var value struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
			Item     struct {
				ID   string `json:"id"`
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
		}
		if err := json.Unmarshal(params, &value); err != nil {
			return nil, nil, err
		}
		if value.ThreadID != p.threadID || (p.turnID != "" && value.TurnID != p.turnID) || value.Item.Type != "agentMessage" {
			return nil, nil, nil
		}
		candidate := strings.TrimSpace(value.Item.Text)
		if candidate == "" {
			return nil, nil, nil
		}
		p.currentItem = value.Item.ID
		p.currentText.Reset()
		p.currentText.WriteString(candidate)
		p.reply = candidate
		delta, err := p.outputDelta(true)
		return delta, nil, err
	case "turn/completed":
		var value struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID     string `json:"id"`
				Status string `json:"status"`
				Error  *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"turn"`
		}
		if err := json.Unmarshal(params, &value); err != nil || value.ThreadID == "" || value.Turn.ID == "" {
			return nil, nil, fmt.Errorf("Codex turn/completed notification is malformed")
		}
		if value.ThreadID != p.threadID || (p.turnID != "" && value.Turn.ID != p.turnID) {
			return nil, nil, nil
		}
		p.complete = true
		if value.Turn.Status != "completed" {
			p.failure = value.Turn.Status
			if value.Turn.Error != nil && strings.TrimSpace(value.Turn.Error.Message) != "" {
				p.failure = value.Turn.Error.Message
			}
		}
		return nil, nil, nil
	case "error":
		var value struct {
			WillRetry bool `json:"willRetry"`
			Error     struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(params, &value); err != nil {
			return nil, nil, err
		}
		if !value.WillRetry {
			p.failure = strings.TrimSpace(value.Error.Message)
		}
		return nil, nil, nil
	default:
		return nil, nil, nil
	}
}

func (p *codexAppServerParser) consumeActivityItem(params json.RawMessage, phase string) error {
	var value struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		Item     struct {
			ID     string `json:"id"`
			Type   string `json:"type"`
			Status string `json:"status"`
			Server string `json:"server"`
			Tool   string `json:"tool"`
		} `json:"item"`
	}
	if err := json.Unmarshal(params, &value); err != nil || value.Item.ID == "" || value.Item.Type == "" {
		return fmt.Errorf("Codex activity item is malformed")
	}
	if value.ThreadID != p.threadID || (p.turnID != "" && value.TurnID != p.turnID) {
		return nil
	}
	if value.Item.Type == "reasoning" {
		if phase == "completed" {
			if preview := p.reasoning[value.Item.ID]; preview != nil {
				p.activities = append(p.activities, preview.project(value.Item.ID, "Thinking", true)...)
				delete(p.reasoning, value.Item.ID)
			}
			p.activities = append(p.activities, Activity{
				ID: value.Item.ID, Kind: "reasoning", Phase: "completed", Label: "Thinking",
			})
		}
		return nil
	}
	label := ""
	switch value.Item.Type {
	case "commandExecution":
		label = "Command"
	case "fileChange":
		label = "File change"
	case "mcpToolCall":
		label = "MCP tool"
		if value.Item.Tool != "" {
			label = value.Item.Tool
		}
	case "dynamicToolCall":
		label = "Tool"
		if value.Item.Tool != "" {
			label = value.Item.Tool
		}
	case "collabAgentToolCall":
		label = "Agent task"
	case "webSearch":
		label = "Web search"
	default:
		return nil
	}
	resolvedPhase := phase
	if phase == "completed" && (value.Item.Status == "failed" || value.Item.Status == "declined") {
		resolvedPhase = "failed"
	}
	if len([]rune(label)) > 120 {
		label = string([]rune(label)[:120])
	}
	p.activities = append(p.activities, Activity{
		ID: value.Item.ID, Kind: "tool", Phase: resolvedPhase, Label: label,
	})
	return nil
}

func (p *codexAppServerParser) outputDelta(force bool) (*OutputDelta, error) {
	visible := p.currentText.String()
	if marker := strings.Index(visible, assessmentOpen); marker >= 0 {
		visible = strings.TrimSpace(visible[:marker])
	}
	if len([]byte(visible)) > maxRuntimeOutput {
		return nil, fmt.Errorf("Codex assistant output exceeded limit")
	}
	visible = RedactSensitiveText(visible)
	if !force {
		runes := []rune(visible)
		if len(runes) <= codexPreviewSafetyRunes {
			visible = ""
		} else {
			visible = string(runes[:len(runes)-codexPreviewSafetyRunes])
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
		return nil, fmt.Errorf("Codex assistant delta is invalid UTF-8")
	}
	p.emittedText = visible
	return &OutputDelta{Content: delta}, nil
}
