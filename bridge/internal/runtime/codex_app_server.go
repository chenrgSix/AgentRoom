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
	"time"
	"unicode/utf8"

	"convenewire.dev/bridge/internal/config"
	contracts "convenewire.dev/contracts/generated/go"
)

const maxCodexProtocolOutput = 4 * 1024 * 1024

var (
	errCodexSessionInUse        = errors.New("Codex session is active in another local client")
	errCodexSessionResumeFailed = errors.New("Codex session resume failed without a safe recreation signal")
)

func (c CodexAdapter) executeAppServer(ctx context.Context, request Request, emit EmitFunc) error {
	if err := validateCodexCommand(c.Config.Command); err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_COMMAND_INVALID", err.Error())
	}
	var sessionKey *RuntimeSessionKey
	var sessionBinding RuntimeSessionBinding
	logicalTaskSession := false
	sessionDisposition := contracts.Started
	resumeThreadID := ""
	promptRun := request.Run
	plan, sessionEligible, planErr := planRuntimeSession("codex", c.Config, request.Run)
	if planErr != nil {
		return emitCodexFailure(ctx, emit, "CODEX_SESSION_STATE_INVALID", "Codex session scope could not be resolved.")
	}
	if c.Sessions != nil && sessionEligible {
		key := plan.Key
		binding, found, err := c.Sessions.Load(key)
		if err != nil {
			return emitCodexFailure(ctx, emit, "CODEX_SESSION_STATE_INVALID", "Codex session state could not be loaded.")
		}
		if found && plan.ResumePolicy == contracts.StartNew {
			if err := c.Sessions.Delete(key); err != nil {
				return emitCodexFailure(ctx, emit, "CODEX_SESSION_STATE_INVALID", "Codex session state could not be reset.")
			}
			found = false
		}
		if found {
			resumeThreadID = binding.SessionID
			sessionBinding = binding
			sessionDisposition = contracts.Resumed
			if plan.LogicalTask {
				promptRun = contextDeltaForSession(request.Run, binding)
			}
		}
		logicalTaskSession = plan.LogicalTask
		sessionKey = &key
	}
	if plan.LogicalTask && hasResultEvidenceCursorGap(request.Run, sessionBinding) {
		return emitCodexFailure(
			ctx, emit, "RESULT_EVIDENCE_CURSOR_GAP",
			"Result evidence does not continue from the accepted Task Session cursor.",
		)
	}
	bootstrapRun, bootstrapConsumption, contextErr := prepareRoomContextForSession(
		request.Run, RuntimeSessionBinding{}, contracts.Recreated,
	)
	if contextErr != nil {
		return emitCodexFailure(ctx, emit, "ROOM_CONTEXT_INVALID", "Room context coverage is invalid.")
	}
	promptRun, roomContextConsumption, contextErr := prepareRoomContextForSession(
		promptRun, sessionBinding, sessionDisposition,
	)
	if contextErr != nil {
		return emitCodexFailure(ctx, emit, "ROOM_CONTEXT_INVALID", "Room context coverage is invalid.")
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
			"name": "convenewire_bridge", "title": "ConveneWire Bridge", "version": "0.2",
		}},
	}); err != nil {
		cancelProcess()
		_ = command.Wait()
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex initialization could not be sent.")
	}

	parser := newCodexAppServerSessionParser(
		c.Config, runtimePromptWithArtifacts(promptRun, request.Artifacts),
		c.Sessions, sessionKey, resumeThreadID,
	)
	parser.bootstrapInstruction = runtimePromptWithArtifacts(bootstrapRun, request.Artifacts)
	parser.artifacts = request.Artifacts
	parser.binding = sessionBinding
	parser.contextCursor = plan.ContextCursor
	parser.bootstrapContextCursor = plan.ContextCursor
	parser.roomContextConsumption = roomContextConsumption
	parser.bootstrapRoomContextConsumption = bootstrapConsumption
	if roomContextConsumption != nil {
		parser.contextCursor = roomContextConsumption.CoverageThroughSequence
	}
	if bootstrapConsumption != nil {
		parser.bootstrapContextCursor = bootstrapConsumption.CoverageThroughSequence
	}
	parser.runtimeScopeID = plan.ScopeID
	parser.roomMemoryRevision, parser.taskMemoryRevision,
		parser.resultEvidenceRevision = contextRevisions(promptRun)
	parser.roomLongTermMemoryRevision, parser.taskLongTermMemoryRevision =
		longTermMemoryRevisions(promptRun)
	parser.bootstrapRoomMemoryRevision, parser.bootstrapTaskMemoryRevision,
		parser.bootstrapResultEvidenceRevision = contextRevisions(bootstrapRun)
	parser.bootstrapRoomLongTermMemoryRevision,
		parser.bootstrapTaskLongTermMemoryRevision = longTermMemoryRevisions(bootstrapRun)
	parser.runID = request.Run.RunID
	parser.logicalTaskSession = logicalTaskSession
	parser.sessionDisposition = sessionDisposition
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
		return emit(ctx, Event{
			Status: &status, Error: runtimeError(code, message),
			Session: parser.acceptedLogicalSessionStatus(),
		})
	}
	if protocolError != nil {
		if errors.Is(protocolError, errCodexSessionInUse) {
			return emitCodexRetryableFailure(
				ctx,
				emit,
				"CODEX_SESSION_IN_USE",
				"Codex session is active in another local client. Close it there and retry.",
			)
		}
		if errors.Is(protocolError, errCodexSessionResumeFailed) {
			return emitCodexRetryableFailure(
				ctx,
				emit,
				"CODEX_SESSION_RESUME_FAILED",
				"Codex session could not be resumed safely. Retry after checking local Codex clients.",
			)
		}
		return emitCodexFailureAfterAcceptance(
			ctx, emit, parser, "CODEX_PROTOCOL_INVALID",
			"Codex emitted an incompatible app-server event stream.", nil,
		)
	}
	if !parser.complete {
		if waitError != nil {
			exitCode := -1
			var exitError *exec.ExitError
			if errors.As(waitError, &exitError) {
				exitCode = exitError.ExitCode()
			}
			stderrText := stderr.String()
			return emitCodexFailureAfterAcceptance(ctx, emit, parser, "CODEX_EXIT_FAILED", "Codex process exited unsuccessfully.", map[string]interface{}{
				"category": classifyRuntimeFailure(stderrText), "exitCode": exitCode,
				"stderrCaptured": strings.TrimSpace(stderrText) != "",
			})
		}
		return emitCodexFailureAfterAcceptance(ctx, emit, parser, "CODEX_OUTCOME_UNKNOWN", "Codex exited without a complete turn envelope.", nil)
	}
	if parser.failure != "" {
		return emitCodexFailureAfterAcceptance(ctx, emit, parser, "CODEX_TURN_FAILED", "Codex reported an unsuccessful turn.", nil)
	}
	if parser.reply == "" {
		return emitCodexFailureAfterAcceptance(ctx, emit, parser, "CODEX_OUTCOME_UNKNOWN", "Codex completed without an assistant reply.", nil)
	}
	if len([]byte(parser.reply)) > maxRuntimeOutput {
		return emitCodexFailureAfterAcceptance(ctx, emit, parser, "CODEX_REPLY_LIMIT", "Codex reply exceeded 20000 bytes.", nil)
	}
	reply, clarification := parseTaskClarificationEnvelope(parser.reply)
	if clarification != nil {
		inputRequired := contracts.InputRequired
		return emit(ctx, Event{
			Status: &inputRequired, Clarification: clarification,
			Session: parser.logicalSessionStatus(),
		})
	}
	reply, assessment := parseAssessmentEnvelope(reply)
	if reply != "" {
		if err := emit(ctx, Event{Reply: reply, Assessment: assessment}); err != nil {
			return err
		}
	}
	completed := contracts.Completed
	return emit(ctx, Event{
		Status:  &completed,
		Session: parser.logicalSessionStatus(),
	})
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
	config                              config.AgentConfig
	instruction                         string
	bootstrapInstruction                string
	sessions                            RuntimeSessionStore
	sessionKey                          *RuntimeSessionKey
	resumeID                            string
	resumeFailed                        bool
	threadID                            string
	turnID                              string
	currentItem                         string
	currentText                         strings.Builder
	emittedText                         string
	reply                               string
	resetPending                        bool
	complete                            bool
	failure                             string
	activities                          []Activity
	reasoning                           map[string]*activityTextPreview
	artifacts                           []VerifiedArtifactAlias
	binding                             RuntimeSessionBinding
	contextCursor                       int64
	bootstrapContextCursor              int64
	roomContextConsumption              *contracts.BridgeRoomContextConsumption
	bootstrapRoomContextConsumption     *contracts.BridgeRoomContextConsumption
	roomMemoryRevision                  int64
	taskMemoryRevision                  int64
	resultEvidenceRevision              int64
	roomLongTermMemoryRevision          int64
	taskLongTermMemoryRevision          int64
	bootstrapRoomMemoryRevision         int64
	bootstrapTaskMemoryRevision         int64
	bootstrapResultEvidenceRevision     int64
	bootstrapRoomLongTermMemoryRevision int64
	bootstrapTaskLongTermMemoryRevision int64
	runID                               string
	logicalTaskSession                  bool
	runtimeScopeID                      string
	sessionDisposition                  contracts.Disposition
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
		config: configuration, instruction: instruction,
		bootstrapInstruction: instruction, sessions: sessions,
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
				"code": -32601, "message": "ConveneWire Bridge cannot answer interactive Codex requests",
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
			if isCodexSessionInUse(message.Error.Message) {
				if p.config.ResolvedCodexSessionConflictPolicy() != config.CodexSessionConflictStartNew {
					return nil, nil, errCodexSessionInUse
				}
				return p.prepareReplacementThread(false)
			}
			if !isCodexSessionMissingOrInvalid(message.Error.Message) {
				return nil, nil, errCodexSessionResumeFailed
			}
			return p.prepareReplacementThread(true)
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
			if err := p.saveSessionBinding(false); err != nil {
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
		if p.sessions != nil && p.sessionKey != nil {
			if err := p.saveSessionBinding(true); err != nil {
				return nil, nil, err
			}
		}
		return nil, nil, nil
	default:
		return nil, nil, nil
	}
}

func (p *codexAppServerParser) prepareReplacementThread(
	deleteStoredBinding bool,
) (*OutputDelta, []any, error) {
	if deleteStoredBinding && p.sessions != nil && p.sessionKey != nil {
		if err := p.sessions.Delete(*p.sessionKey); err != nil {
			return nil, nil, err
		}
	}
	p.resumeID = ""
	p.resumeFailed = true
	p.instruction = p.bootstrapInstruction
	p.binding = RuntimeSessionBinding{}
	p.roomMemoryRevision = p.bootstrapRoomMemoryRevision
	p.taskMemoryRevision = p.bootstrapTaskMemoryRevision
	p.resultEvidenceRevision = p.bootstrapResultEvidenceRevision
	p.roomLongTermMemoryRevision = p.bootstrapRoomLongTermMemoryRevision
	p.taskLongTermMemoryRevision = p.bootstrapTaskLongTermMemoryRevision
	if p.logicalTaskSession {
		p.sessionDisposition = contracts.Recreated
	}
	if p.bootstrapRoomContextConsumption != nil {
		p.contextCursor = p.bootstrapContextCursor
		p.roomContextConsumption = p.bootstrapRoomContextConsumption
	}
	return nil, []any{p.threadRequest()}, nil
}

func isCodexSessionInUse(message string) bool {
	normalized := strings.ToLower(strings.TrimSpace(message))
	return strings.Contains(normalized, "thread-store conflict") &&
		strings.Contains(normalized, "already has an active writer")
}

func isCodexSessionMissingOrInvalid(message string) bool {
	normalized := strings.ToLower(strings.TrimSpace(message))
	if normalized == "not found" {
		return true
	}
	return (strings.Contains(normalized, "thread") &&
		(strings.Contains(normalized, "not found") ||
			strings.Contains(normalized, "does not exist") ||
			strings.Contains(normalized, "unknown thread"))) ||
		strings.Contains(normalized, "invalid thread id") ||
		strings.Contains(normalized, "thread id is invalid")
}

func (p *codexAppServerParser) saveSessionBinding(consumed bool) error {
	now := time.Now().UTC()
	binding := p.binding
	binding.RuntimeSessionKey = *p.sessionKey
	binding.SessionID = p.threadID
	if binding.CreatedAt.IsZero() {
		binding.CreatedAt = now
	}
	if consumed {
		if p.contextCursor > binding.LastRoomSequence {
			binding.LastRoomSequence = p.contextCursor
		}
		binding.LastRunID = p.runID
		if p.roomMemoryRevision > binding.RoomMemoryRevision {
			binding.RoomMemoryRevision = p.roomMemoryRevision
		}
		if p.taskMemoryRevision > binding.TaskMemoryRevision {
			binding.TaskMemoryRevision = p.taskMemoryRevision
		}
		if p.roomLongTermMemoryRevision > binding.RoomLongTermMemoryRevision {
			binding.RoomLongTermMemoryRevision = p.roomLongTermMemoryRevision
		}
		if p.taskLongTermMemoryRevision > binding.TaskLongTermMemoryRevision {
			binding.TaskLongTermMemoryRevision = p.taskLongTermMemoryRevision
		}
		if p.resultEvidenceRevision > binding.ResultEvidenceRevision {
			binding.ResultEvidenceRevision = p.resultEvidenceRevision
		}
	}
	binding.UpdatedAt = now
	if err := p.sessions.Save(binding); err != nil {
		return err
	}
	p.binding = binding
	return nil
}

func (p *codexAppServerParser) logicalSessionStatus() *contracts.LogicalSessionStatus {
	if !p.logicalTaskSession {
		return nil
	}
	return sessionStatus(
		p.sessionDisposition,
		p.binding.LastRoomSequence,
		p.runtimeScopeID,
		p.binding.ResultEvidenceRevision,
		p.roomContextConsumption,
	)
}

func (p *codexAppServerParser) acceptedLogicalSessionStatus() *contracts.LogicalSessionStatus {
	if p.binding.LastRunID != p.runID {
		return nil
	}
	return p.logicalSessionStatus()
}

func emitCodexFailureAfterAcceptance(
	ctx context.Context,
	emit EmitFunc,
	parser *codexAppServerParser,
	code string,
	message string,
	details map[string]interface{},
) error {
	failed := contracts.Failed
	errorValue := runtimeError(code, message)
	if details != nil {
		errorValue = runtimeErrorWithDetails(code, message, details)
	}
	return emit(ctx, Event{
		Status: &failed, Error: errorValue,
		Session: parser.acceptedLogicalSessionStatus(),
	})
}

func emitCodexRetryableFailure(
	ctx context.Context,
	emit EmitFunc,
	code string,
	message string,
) error {
	failed := contracts.Failed
	errorValue := runtimeError(code, message)
	errorValue.Retryable = true
	return emit(ctx, Event{Status: &failed, Error: errorValue})
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
			preview = &activityTextPreview{artifacts: p.artifacts}
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
	visible := stripPrivateEnvelopePreview(p.currentText.String())
	if len([]byte(visible)) > maxRuntimeOutput {
		return nil, fmt.Errorf("Codex assistant output exceeded limit")
	}
	visible = RedactRuntimeText(visible, p.artifacts)
	if !force {
		runes := []rune(visible)
		safetyRunes := artifactPreviewSafetyRunes(p.artifacts)
		if len(runes) <= safetyRunes {
			visible = ""
		} else {
			visible = string(runes[:len(runes)-safetyRunes])
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
