package runtime

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const maxRuntimeOutput = 20_000

var errOutputLimit = errors.New("Runtime output exceeded limit")

type GenericAdapter struct {
	Config config.AgentConfig
}

func (g GenericAdapter) Name() string { return "generic" }

func (g GenericAdapter) Capabilities() Capabilities {
	return Capabilities{SupportsInterrupt: true}
}

func (g GenericAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
	working := contracts.Working
	if err := emit(ctx, Event{Status: &working}); err != nil {
		return err
	}
	runContext := ctx
	cancel := func() {}
	if !request.Run.Deadline.IsZero() {
		runContext, cancel = context.WithDeadline(ctx, request.Run.Deadline)
	}
	defer cancel()
	command := exec.CommandContext(runContext, g.Config.Command[0], g.Config.Command[1:]...)
	command.Dir = g.Config.Workspace
	command.Env = allowedEnvironment(g.Config.EnvAllowlist)
	command.Stdin = strings.NewReader(request.Run.Instruction)
	stdout := &limitedBuffer{remaining: maxRuntimeOutput}
	stderr := &limitedBuffer{remaining: 4_096}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
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
	if errors.Is(err, errOutputLimit) || errors.Is(stdout.err, errOutputLimit) || errors.Is(stderr.err, errOutputLimit) {
		failed := contracts.Failed
		return emit(ctx, Event{
			Status: &failed,
			Error:  runtimeError("RUNTIME_OUTPUT_LIMIT", "Runtime output exceeded 20000 bytes."),
		})
	}
	if err != nil {
		failed := contracts.Failed
		var exitError *exec.ExitError
		if !errors.As(err, &exitError) {
			return emit(ctx, Event{
				Status: &failed,
				Error: runtimeErrorWithDetails(
					"RUNTIME_START_FAILED",
					"Runtime process could not be started.",
					map[string]interface{}{"category": "start"},
				),
			})
		}
		stderrText := stderr.String()
		return emit(ctx, Event{
			Status: &failed,
			Error: runtimeErrorWithDetails(
				"RUNTIME_EXIT_FAILED",
				"Runtime process exited unsuccessfully.",
				map[string]interface{}{
					"category":       classifyRuntimeFailure(stderrText),
					"exitCode":       exitError.ExitCode(),
					"stderrCaptured": strings.TrimSpace(stderrText) != "",
				},
			),
		})
	}
	reply, assessment := parseAssessmentEnvelope(stdout.String())
	if reply != "" {
		if err := emit(ctx, Event{Reply: reply, Assessment: assessment}); err != nil {
			return err
		}
	}
	completed := contracts.Completed
	return emit(ctx, Event{Status: &completed})
}

func allowedEnvironment(allowlist []string) []string {
	environment := make([]string, 0, len(allowlist))
	for _, name := range allowlist {
		if value, ok := os.LookupEnv(name); ok {
			environment = append(environment, name+"="+value)
		}
	}
	return environment
}

func runtimeError(code, message string) *contracts.AgentRoomError {
	return &contracts.AgentRoomError{
		Code: code, Message: message, Retryable: false,
	}
}

func runtimeErrorWithDetails(
	code string,
	message string,
	details map[string]interface{},
) *contracts.AgentRoomError {
	errorValue := runtimeError(code, message)
	errorValue.Details = details
	return errorValue
}

// classifyRuntimeFailure deliberately returns only a stable category. Runtime
// stderr can contain prompts, provider responses, credentials, or local paths
// and must never cross the Bridge protocol boundary.
func classifyRuntimeFailure(stderr string) string {
	normalized := strings.ToLower(stderr)
	groups := []struct {
		category string
		markers  []string
	}{
		{category: "authentication", markers: []string{
			"unauthorized", "authentication", "api key", "credential", "login required",
		}},
		{category: "rate_limit", markers: []string{
			"rate limit", "too many requests", "status 429", "status=429", "http 429",
		}},
		{category: "network", markers: []string{
			"network", "econn", "connection reset", "connection refused", "dns", "socket",
		}},
		{category: "model", markers: []string{
			"model not found", "unknown model", "model unavailable", "provider error", "inference",
		}},
		{category: "configuration", markers: []string{
			"configuration", "config error", "extension", "settings", "permission denied",
			"operation not permitted", "eperm",
		}},
	}
	for _, group := range groups {
		for _, marker := range group.markers {
			if strings.Contains(normalized, marker) {
				return group.category
			}
		}
	}
	return "unknown"
}

type limitedBuffer struct {
	buffer    bytes.Buffer
	remaining int
	err       error
}

func (b *limitedBuffer) Write(source []byte) (int, error) {
	if len(source) > b.remaining {
		if b.remaining > 0 {
			_, _ = b.buffer.Write(source[:b.remaining])
			b.remaining = 0
		}
		b.err = errOutputLimit
		return 0, errOutputLimit
	}
	written, err := b.buffer.Write(source)
	b.remaining -= written
	return written, err
}

func (b *limitedBuffer) String() string { return b.buffer.String() }
