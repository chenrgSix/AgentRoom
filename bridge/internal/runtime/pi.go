package runtime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const maxPiProtocolOutput = 512 * 1024

var errPiProtocolInvalid = errors.New("Pi returned an incompatible event stream")

// PiAdapter keeps Pi behind its documented JSON event boundary. It deliberately
// exposes only the final assistant text; session headers, deltas, tool events,
// and provider-specific protocol fragments remain local to the Bridge.
type PiAdapter struct {
	Config config.AgentConfig
}

func (p PiAdapter) Name() string { return "pi" }

func (p PiAdapter) Capabilities() Capabilities {
	return Capabilities{SupportsInterrupt: true}
}

func (p PiAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
	protocolFailed := false
	replied := false
	return (GenericAdapter{
		Config: p.Config, outputLimit: maxPiProtocolOutput,
	}).Execute(ctx, request, func(eventContext context.Context, event Event) error {
		if event.Reply != "" {
			reply, err := parsePiEventStream(event.Reply)
			if err != nil {
				protocolFailed = true
				return emitPiProtocolFailure(eventContext, emit)
			}
			reply, assessment := parseAssessmentEnvelope(reply)
			if len([]byte(reply)) > maxRuntimeOutput {
				protocolFailed = true
				failed := contracts.Failed
				return emit(eventContext, Event{
					Status: &failed,
					Error: runtimeError(
						"RUNTIME_OUTPUT_LIMIT",
						"Runtime reply exceeded its safe limit.",
					),
				})
			}
			replied = true
			return emit(eventContext, Event{Reply: reply, Assessment: assessment})
		}
		if event.Status != nil && *event.Status == contracts.Completed {
			if protocolFailed {
				return nil
			}
			if !replied {
				return emitPiProtocolFailure(eventContext, emit)
			}
		}
		return emit(eventContext, event)
	})
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
	Type    string     `json:"type"`
	Message *piMessage `json:"message"`
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

func parsePiEventStream(source string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewBufferString(source))
	scanner.Buffer(make([]byte, 64*1024), maxPiProtocolOutput)
	lastReply := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		decoder := json.NewDecoder(strings.NewReader(line))
		var event piEvent
		if err := decoder.Decode(&event); err != nil {
			return "", errPiProtocolInvalid
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			return "", errPiProtocolInvalid
		}
		if event.Type != "message_end" || event.Message == nil || event.Message.Role != "assistant" {
			continue
		}
		if event.Message.StopReason == "error" || event.Message.StopReason == "aborted" ||
			strings.TrimSpace(event.Message.ErrorMessage) != "" {
			return "", errPiProtocolInvalid
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
		if hasToolCall {
			lastReply = ""
		} else if candidate != "" {
			lastReply = candidate
		}
	}
	if scanner.Err() != nil || lastReply == "" || containsLeakedToolProtocol(lastReply) {
		return "", errPiProtocolInvalid
	}
	return lastReply, nil
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
