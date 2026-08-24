package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
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

// PiAdapter keeps Pi behind its documented JSON event boundary. Only assistant
// text deltas and the final assistant reply may cross the Bridge boundary;
// thinking, usage, tool events, and provider-specific fragments remain local.
type PiAdapter struct {
	Config config.AgentConfig
}

func (p PiAdapter) Name() string { return "pi" }

func (p PiAdapter) Capabilities() Capabilities {
	return Capabilities{SupportsStreaming: true, SupportsInterrupt: true}
}

func (p PiAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
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
	command := exec.CommandContext(processContext, p.Config.Command[0], p.Config.Command[1:]...)
	configureRuntimeCommand(command)
	command.Dir = p.Config.Workspace
	command.Env = allowedEnvironment(p.Config.EnvAllowlist)
	command.Stdin = strings.NewReader(request.Run.Instruction)
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
	if err := emit(ctx, Event{Reply: reply, Assessment: assessment}); err != nil {
		return err
	}
	completed := contracts.Completed
	return emit(ctx, Event{Status: &completed})
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
		if event.AssistantMessageEvent == nil || event.AssistantMessageEvent.Type != "text_delta" {
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
