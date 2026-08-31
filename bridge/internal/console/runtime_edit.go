package console

import (
	"fmt"
	"strings"

	"convenewire.dev/bridge/internal/config"
)

// Editing an existing profile is not preset creation or migration. The saved
// profile is authoritative for fields the form does not expose.
func editPresetRuntime(previous config.AgentConfig, input RuntimeInput) (config.AgentConfig, error) {
	agent, err := editRuntimeMetadata(previous, input)
	if err != nil {
		return config.AgentConfig{}, err
	}
	if len(previous.Command) == 0 {
		return config.AgentConfig{}, fmt.Errorf("Runtime command is missing")
	}
	if input.ExecutablePath != previous.Command[0] {
		executable, err := executableFile(input.ExecutablePath)
		if err != nil {
			return config.AgentConfig{}, fmt.Errorf("Runtime executable: %w", err)
		}
		agent.Command = append([]string(nil), previous.Command...)
		agent.Command[0] = executable
	}
	switch previous.RuntimeKind {
	case "codex":
		if input.CredentialEnvironmentVar != "" {
			return config.AgentConfig{}, fmt.Errorf("Codex editing cannot change a Pi credential variable")
		}
		if input.Sandbox != "" {
			if input.Sandbox != "read-only" && input.Sandbox != "workspace-write" {
				return config.AgentConfig{}, fmt.Errorf("Codex sandbox must be read-only or workspace-write")
			}
			agent.Sandbox = input.Sandbox
		}
		if input.CodexSessionConflictPolicy != "" && input.CodexSessionConflictPolicy != previous.ResolvedCodexSessionConflictPolicy() {
			agent.CodexSessionConflictPolicy = input.CodexSessionConflictPolicy
		}
	case "pi":
		if input.Sandbox != "" || input.CodexSessionConflictPolicy != "" {
			return config.AgentConfig{}, fmt.Errorf("Pi editing cannot change Codex policies")
		}
		selected := strings.TrimSpace(input.CredentialEnvironmentVar)
		if selected != "" && !environmentName.MatchString(selected) {
			return config.AgentConfig{}, fmt.Errorf("Pi credential environment variable name is invalid")
		}
		old := piCredentialEnvironment(previous.EnvAllowlist)
		if selected != old {
			agent.EnvAllowlist = make([]string, 0, len(previous.EnvAllowlist)+1)
			for _, name := range previous.EnvAllowlist {
				if name == old {
					if selected != "" {
						agent.EnvAllowlist = appendUnique(agent.EnvAllowlist, selected)
					}
				} else {
					agent.EnvAllowlist = appendUnique(agent.EnvAllowlist, name)
				}
			}
			if old == "" && selected != "" {
				agent.EnvAllowlist = appendUnique(agent.EnvAllowlist, selected)
			}
		}
	default:
		return config.AgentConfig{}, fmt.Errorf("unsupported Runtime kind for preset editing")
	}
	return agent, nil
}

func piCredentialEnvironment(allowlist []string) string {
	for _, name := range allowlist {
		switch name {
		case "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY":
		default:
			return name
		}
	}
	return ""
}
