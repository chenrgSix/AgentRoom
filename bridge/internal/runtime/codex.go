package runtime

import (
	"context"
	"fmt"
	"path/filepath"

	"convenewire.dev/bridge/internal/config"
	contracts "convenewire.dev/contracts/generated/go"
)

type CodexAdapter struct {
	Config   config.AgentConfig
	Sessions RuntimeSessionStore
}

func (c CodexAdapter) Name() string { return "codex" }

func (c CodexAdapter) Capabilities() Capabilities {
	return Capabilities{
		SupportsResume: true, SupportsStreaming: true, SupportsInterrupt: true,
		SupportsRoomContextCoverage: true,
	}
}

func (c CodexAdapter) Execute(ctx context.Context, request Request, emit EmitFunc) error {
	return c.executeAppServer(ctx, request, emit)
}

func validateCodexCommand(command []string) error {
	if len(command) == 0 {
		return fmt.Errorf("Codex command is empty")
	}
	hasAppServer := false
	for index, argument := range command[1:] {
		switch argument {
		case "app-server":
			hasAppServer = true
		case "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust":
			return fmt.Errorf("unsafe Codex bypass flag is not allowed")
		case "--listen":
			resolved := index + 2
			if resolved >= len(command) || command[resolved] != "stdio://" {
				return fmt.Errorf("Codex app-server must use the stdio transport")
			}
		}
	}
	if !hasAppServer {
		return fmt.Errorf("Codex command must contain app-server")
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
