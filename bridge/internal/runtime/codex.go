package runtime

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const maxCodexJSONLOutput = 1_000_000

type CodexAdapter struct {
	Config config.AgentConfig
}

func (c CodexAdapter) Name() string { return "codex" }

func (c CodexAdapter) Capabilities() Capabilities {
	return Capabilities{SupportsInterrupt: true}
}

func (c CodexAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
	working := contracts.Working
	if err := emit(ctx, Event{Status: &working}); err != nil {
		return err
	}
	if err := validateCodexCommand(c.Config.Command); err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_COMMAND_INVALID", err.Error())
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
	command.Stdin = strings.NewReader(request.Run.Instruction)
	stdout, err := command.StdoutPipe()
	if err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex stdout could not be opened.")
	}
	stderr := &limitedBuffer{remaining: 8_192}
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return emitCodexFailure(ctx, emit, "CODEX_START_FAILED", "Codex process could not be started.")
	}

	parser := &CodexEventParser{}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), maxCodexJSONLOutput)
	total := 0
	var protocolError error
	for scanner.Scan() {
		total += len(scanner.Bytes()) + 1
		if total > maxCodexJSONLOutput {
			protocolError = fmt.Errorf("Codex JSONL output exceeded limit")
			break
		}
		if err := parser.Consume(scanner.Bytes()); err != nil {
			protocolError = err
			break
		}
	}
	if scanner.Err() != nil && protocolError == nil {
		protocolError = scanner.Err()
	}
	if protocolError != nil {
		cancelProcess()
	}
	waitError := command.Wait()
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
		return emitCodexFailure(ctx, emit, "CODEX_PROTOCOL_INVALID", "Codex emitted incompatible JSONL output.")
	}
	if waitError != nil {
		exitCode := -1
		var exitError *exec.ExitError
		if errors.As(waitError, &exitError) {
			exitCode = exitError.ExitCode()
		}
		stderrText := stderr.String()
		return emitCodexFailureWithDetails(
			ctx,
			emit,
			"CODEX_EXIT_FAILED",
			"Codex process exited unsuccessfully.",
			map[string]interface{}{
				"category":       classifyRuntimeFailure(stderrText),
				"exitCode":       exitCode,
				"stderrCaptured": strings.TrimSpace(stderrText) != "",
			},
		)
	}
	if parser.Failure != "" {
		return emitCodexFailure(ctx, emit, "CODEX_TURN_FAILED", "Codex reported an unsuccessful turn.")
	}
	if parser.ThreadID == "" || !parser.Complete {
		return emitCodexFailure(ctx, emit, "CODEX_OUTCOME_UNKNOWN", "Codex exited without a complete turn envelope.")
	}
	if len(parser.Reply) > maxRuntimeOutput {
		return emitCodexFailure(ctx, emit, "CODEX_REPLY_LIMIT", "Codex reply exceeded 20000 bytes.")
	}
	reply, assessment := parseAssessmentEnvelope(parser.Reply)
	if reply != "" {
		if err := emit(ctx, Event{Reply: reply, Assessment: assessment}); err != nil {
			return err
		}
	}
	completed := contracts.Completed
	return emit(ctx, Event{Status: &completed})
}

func validateCodexCommand(command []string) error {
	if len(command) == 0 {
		return fmt.Errorf("Codex command is empty")
	}
	hasExec := false
	hasJSON := false
	for _, argument := range command[1:] {
		switch argument {
		case "exec":
			hasExec = true
		case "--json":
			hasJSON = true
		case "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust":
			return fmt.Errorf("unsafe Codex bypass flag is not allowed")
		case "-C", "--cd", "--add-dir":
			return fmt.Errorf("Codex workspace override is not allowed")
		}
	}
	if !hasExec || !hasJSON {
		return fmt.Errorf("Codex command must contain exec and --json")
	}
	if filepath.Base(command[0]) == "" {
		return fmt.Errorf("Codex executable is invalid")
	}
	return nil
}

func emitCodexFailure(ctx context.Context, emit EmitFunc, code, message string) error {
	failed := contracts.Failed
	return emit(ctx, Event{Status: &failed, Error: runtimeError(code, message)})
}

func emitCodexFailureWithDetails(
	ctx context.Context,
	emit EmitFunc,
	code string,
	message string,
	details map[string]interface{},
) error {
	failed := contracts.Failed
	return emit(ctx, Event{
		Status: &failed,
		Error:  runtimeErrorWithDetails(code, message, details),
	})
}
