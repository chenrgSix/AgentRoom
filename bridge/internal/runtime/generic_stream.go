package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"
	"unicode/utf8"

	contracts "agentroom.dev/contracts/generated/go"
)

const maxGenericProtocolOutput = 512 * 1024

var errGenericProtocolInvalid = errors.New("Generic Runtime returned an incompatible event stream")
var errGenericOutputLimit = errors.New("Generic Runtime assistant output exceeded its safe limit")

func (g GenericAdapter) executeStructured(ctx context.Context, request Request, emit EmitFunc) error {
	runContext := ctx
	cancelDeadline := func() {}
	if !request.Run.Deadline.IsZero() {
		runContext, cancelDeadline = context.WithDeadline(ctx, request.Run.Deadline)
	}
	defer cancelDeadline()
	processContext, cancelProcess := context.WithCancel(runContext)
	defer cancelProcess()

	command := exec.CommandContext(processContext, g.Config.Command[0], g.Config.Command[1:]...)
	configureRuntimeCommand(command)
	command.Dir = g.Config.Workspace
	command.Env = allowedEnvironment(g.Config.EnvAllowlist)
	command.Stdin = strings.NewReader(runtimePromptWithArtifacts(
		request.Run,
		request.Artifacts,
	))
	stdout, err := command.StdoutPipe()
	if err != nil {
		return emitGenericStartFailure(ctx, emit)
	}
	stderr := &limitedBuffer{remaining: 4_096}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return emitGenericStartFailure(ctx, emit)
	}

	parser := &genericStreamParser{artifacts: request.Artifacts}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxGenericProtocolOutput)
	total := 0
	var protocolError error
	var executionError error
	for scanner.Scan() {
		total += len(scanner.Bytes()) + 1
		if total > maxGenericProtocolOutput {
			protocolError = errGenericOutputLimit
			break
		}
		delta, consumeError := parser.consume(scanner.Bytes())
		if consumeError != nil {
			protocolError = consumeError
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
	}
	if scanner.Err() != nil && protocolError == nil {
		// Scanner only fails here when a producer exceeds the configured JSONL
		// record bound or the stdout pipe itself becomes unreadable. Keep the
		// raw scanner error private and expose the bounded-output failure class.
		protocolError = errGenericOutputLimit
	}
	if protocolError != nil || executionError != nil {
		cancelProcess()
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
	if errors.Is(protocolError, errGenericOutputLimit) || errors.Is(stderr.err, errOutputLimit) {
		failed := contracts.Failed
		return emit(ctx, Event{Status: &failed, Error: runtimeError(
			"RUNTIME_OUTPUT_LIMIT", "Runtime output exceeded its safe limit.",
		)})
	}
	if protocolError != nil {
		return emitGenericProtocolFailure(ctx, emit)
	}
	if waitError != nil {
		failed := contracts.Failed
		var exitError *exec.ExitError
		if !errors.As(waitError, &exitError) {
			return emitGenericStartFailure(ctx, emit)
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
	if !parser.finalSeen || parser.finalReply == "" || containsLeakedToolProtocol(parser.finalReply) {
		return emitGenericProtocolFailure(ctx, emit)
	}
	reply, clarification := parseTaskClarificationEnvelope(parser.finalReply)
	if clarification != nil {
		inputRequired := contracts.InputRequired
		return emit(ctx, Event{Status: &inputRequired, Clarification: clarification})
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

func emitGenericStartFailure(ctx context.Context, emit EmitFunc) error {
	failed := contracts.Failed
	return emit(ctx, Event{Status: &failed, Error: runtimeErrorWithDetails(
		"RUNTIME_START_FAILED", "Runtime process could not be started.",
		map[string]interface{}{"category": "start"},
	)})
}

func emitGenericProtocolFailure(ctx context.Context, emit EmitFunc) error {
	failed := contracts.Failed
	return emit(ctx, Event{Status: &failed, Error: runtimeErrorWithDetails(
		"RUNTIME_PROTOCOL_INVALID", "Runtime returned an incompatible structured response.",
		map[string]interface{}{"category": "model"},
	)})
}

type genericStreamEvent struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Delta   string `json:"delta"`
	Reset   bool   `json:"reset"`
	Text    string `json:"text"`
	IsError bool   `json:"isError"`
}

type genericStreamParser struct {
	currentText  strings.Builder
	emittedText  string
	finalReply   string
	resetPending bool
	finalSeen    bool
	activities   []Activity
	reasoning    map[string]*activityTextPreview
	artifacts    []VerifiedArtifactAlias
}

func (p *genericStreamParser) drainActivities() []Activity {
	activities := p.activities
	p.activities = nil
	return activities
}

func (p *genericStreamParser) consume(source []byte) (*OutputDelta, error) {
	line := strings.TrimSpace(string(source))
	if line == "" {
		return nil, nil
	}
	decoder := json.NewDecoder(strings.NewReader(line))
	var event genericStreamEvent
	if err := decoder.Decode(&event); err != nil {
		return nil, errGenericProtocolInvalid
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errGenericProtocolInvalid
	}
	if event.Type == "" {
		return nil, errGenericProtocolInvalid
	}
	switch event.Type {
	case "reasoning.delta":
		if p.finalSeen || event.ID == "" || len(event.ID) > 160 || event.Delta == "" {
			return nil, errGenericProtocolInvalid
		}
		if p.reasoning == nil {
			p.reasoning = make(map[string]*activityTextPreview)
		}
		preview := p.reasoning[event.ID]
		if preview == nil {
			preview = &activityTextPreview{artifacts: p.artifacts}
			p.reasoning[event.ID] = preview
		}
		preview.append(event.Delta, event.Reset)
		p.activities = append(p.activities, preview.project(event.ID, "Thinking", false)...)
		return nil, nil
	case "reasoning.completed":
		if event.ID == "" || len(event.ID) > 160 {
			return nil, errGenericProtocolInvalid
		}
		if preview := p.reasoning[event.ID]; preview != nil {
			p.activities = append(p.activities, preview.project(event.ID, "Thinking", true)...)
			delete(p.reasoning, event.ID)
		}
		p.activities = append(p.activities, Activity{
			ID: event.ID, Kind: "reasoning", Phase: "completed", Label: "Thinking",
		})
		return nil, nil
	case "tool.started", "tool.completed":
		if event.ID == "" || len(event.ID) > 160 || strings.TrimSpace(event.Name) == "" {
			return nil, errGenericProtocolInvalid
		}
		label := strings.TrimSpace(event.Name)
		if len([]rune(label)) > 120 {
			label = string([]rune(label)[:120])
		}
		phase := "started"
		if event.Type == "tool.completed" {
			phase = "completed"
			if event.IsError {
				phase = "failed"
			}
		}
		p.activities = append(p.activities, Activity{
			ID: event.ID, Kind: "tool", Phase: phase, Label: label,
		})
		return nil, nil
	case "assistant.delta":
		if p.finalSeen || event.Delta == "" {
			return nil, errGenericProtocolInvalid
		}
		if event.Reset {
			p.currentText.Reset()
			p.resetPending = p.emittedText != ""
		}
		p.currentText.WriteString(event.Delta)
		return p.outputDelta(false)
	case "reply.final":
		if p.finalSeen || strings.TrimSpace(event.Text) == "" {
			return nil, errGenericProtocolInvalid
		}
		p.finalSeen = true
		p.finalReply = strings.TrimSpace(event.Text)
		p.currentText.Reset()
		p.currentText.WriteString(p.finalReply)
		return p.outputDelta(true)
	default:
		// Unknown structured events are private Runtime control events. They are
		// intentionally ignored and never projected as assistant output.
		return nil, nil
	}
}

func (p *genericStreamParser) outputDelta(force bool) (*OutputDelta, error) {
	visible := stripPrivateEnvelopePreview(p.currentText.String())
	if containsLeakedToolProtocol(visible) {
		return nil, errGenericProtocolInvalid
	}
	if len([]byte(visible)) > maxRuntimeOutput {
		return nil, errGenericOutputLimit
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
		return nil, errGenericProtocolInvalid
	}
	p.emittedText = visible
	return &OutputDelta{Content: delta}, nil
}
