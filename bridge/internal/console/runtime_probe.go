package console

import (
	"context"
	"strings"
	"time"

	"agentroom.dev/bridge/internal/config"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

const runtimeProbeTimeout = 45 * time.Second

type RuntimeProbeResult struct {
	Passed         bool   `json:"passed"`
	Code           string `json:"code"`
	Category       string `json:"category,omitempty"`
	ExitCode       *int   `json:"exitCode,omitempty"`
	StderrCaptured bool   `json:"stderrCaptured"`
	DurationMillis int64  `json:"durationMillis"`
}

func ProbeRuntime(ctx context.Context, agent config.AgentConfig) RuntimeProbeResult {
	started := time.Now()
	probeContext, cancel := context.WithTimeout(ctx, runtimeProbeTimeout)
	defer cancel()

	probeConfig := agent
	probeConfig.Command = append([]string{}, agent.Command...)
	if agent.RuntimeKind == "codex" && len(probeConfig.Command) > 0 {
		probeConfig.Command = config.CodexPresetCommand(probeConfig.Command[0], "read-only")
	}
	var adapter bridgeruntime.Adapter
	switch probeConfig.Adapter {
	case "codex":
		adapter = bridgeruntime.CodexAdapter{Config: probeConfig}
	case "generic":
		adapter = bridgeruntime.GenericAdapter{Config: probeConfig}
	default:
		return probeFailure(started, "RUNTIME_PROBE_ADAPTER_INVALID", "configuration", nil, false)
	}

	var reply string
	var terminalStatus *contracts.RunExecutionStatus
	var terminalError *contracts.AgentRoomError
	err := adapter.Execute(probeContext, bridgeruntime.Request{
		Run: contracts.RunRequestedPayload{
			Instruction: "Reply exactly AGENTROOM_READY. Do not inspect or modify files.",
			Deadline:    time.Now().Add(runtimeProbeTimeout),
		},
	}, func(_ context.Context, event bridgeruntime.Event) error {
		if event.Reply != "" {
			reply = event.Reply
		}
		if event.Status != nil {
			status := *event.Status
			terminalStatus = &status
		}
		if event.Error != nil {
			terminalError = event.Error
		}
		return nil
	})
	if terminalError != nil {
		category, exitCode, stderrCaptured := safeProbeDetails(terminalError.Details)
		return probeFailure(started, terminalError.Code, category, exitCode, stderrCaptured)
	}
	if err != nil {
		return probeFailure(started, "RUNTIME_PROBE_FAILED", "unknown", nil, false)
	}
	if terminalStatus == nil || *terminalStatus != contracts.Completed {
		return probeFailure(started, "RUNTIME_PROBE_INCOMPLETE", "unknown", nil, false)
	}
	if strings.TrimSpace(reply) != "AGENTROOM_READY" {
		return probeFailure(started, "RUNTIME_PROBE_REPLY_INVALID", "configuration", nil, false)
	}
	return RuntimeProbeResult{
		Passed: true, Code: "RUNTIME_PROBE_OK",
		DurationMillis: time.Since(started).Milliseconds(),
	}
}

func probeFailure(
	started time.Time,
	code string,
	category string,
	exitCode *int,
	stderrCaptured bool,
) RuntimeProbeResult {
	return RuntimeProbeResult{
		Passed: false, Code: code, Category: category, ExitCode: exitCode,
		StderrCaptured: stderrCaptured,
		DurationMillis: time.Since(started).Milliseconds(),
	}
}

func safeProbeDetails(details map[string]interface{}) (string, *int, bool) {
	category := "unknown"
	if value, ok := details["category"].(string); ok {
		switch value {
		case "start", "authentication", "rate_limit", "network", "model", "configuration", "unknown":
			category = value
		}
	}
	var exitCode *int
	switch value := details["exitCode"].(type) {
	case int:
		exitCode = &value
	case float64:
		converted := int(value)
		if float64(converted) == value {
			exitCode = &converted
		}
	}
	stderrCaptured, _ := details["stderrCaptured"].(bool)
	return category, exitCode, stderrCaptured
}
