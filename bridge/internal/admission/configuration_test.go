package admission

import (
	"errors"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
)

func TestCodexConfigurationDigestBindsExecutionAndIgnoresDisplayWorkspace(t *testing.T) {
	agent := config.AgentConfig{Name: "Builder", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
		PresetVersion: config.CurrentPresetVersion, Command: []string{"/Applications/ChatGPT.app/codex", "app-server", "--listen", "stdio://"},
		Workspace: "/owner/source", WorkspaceAlias: "Source", Sandbox: "workspace-write",
		CodexSessionConflictPolicy: config.CodexSessionConflictPreserveAndRetry, EnvAllowlist: []string{"PATH", "HOME"}}
	digest, err := CodexConfigurationDigest(agent, "agent_profile0001", "convenewire_governed")
	if err != nil || len(digest) != 64 {
		t.Fatalf("digest=%q err=%v", digest, err)
	}
	display := agent
	display.Name, display.Role, display.Workspace, display.WorkspaceAlias = "Renamed", "Reviewer", "/other/ordinary", "Other"
	display.EnvAllowlist = []string{"HOME", "PATH"}
	if replay, err := CodexConfigurationDigest(display, "agent_profile0001", "convenewire_governed"); err != nil || replay != digest {
		t.Fatalf("display/workspace drift changed governed digest: %q %v", replay, err)
	}
	for name, change := range map[string]func(*config.AgentConfig){
		"command": func(v *config.AgentConfig) { v.Command = append(v.Command, "--extra") },
		"sandbox": func(v *config.AgentConfig) { v.Sandbox = "read-only" },
		"policy":  func(v *config.AgentConfig) { v.CodexSessionConflictPolicy = config.CodexSessionConflictStartNew },
		"env":     func(v *config.AgentConfig) { v.EnvAllowlist = append(v.EnvAllowlist, "LANG") },
	} {
		t.Run(name, func(t *testing.T) {
			changed := agent
			changed.Command = append([]string{}, agent.Command...)
			changed.EnvAllowlist = append([]string{}, agent.EnvAllowlist...)
			change(&changed)
			updated, err := CodexConfigurationDigest(changed, "agent_profile0001", "convenewire_governed")
			if name == "sandbox" {
				if !errors.Is(err, ErrProfileInvalid) {
					t.Fatalf("read-only coding profile error=%v", err)
				}
				return
			}
			if err != nil || updated == digest {
				t.Fatalf("execution drift digest=%q err=%v", updated, err)
			}
		})
	}
}

func TestCodexConfigurationDigestRejectsAmbiguousInputs(t *testing.T) {
	base := config.AgentConfig{Adapter: "codex", RuntimeKind: "codex", PresetVersion: config.CurrentPresetVersion,
		Command: []string{"codex", "app-server", "--listen", "stdio://"}, Workspace: "/workspace", Sandbox: "workspace-write",
		EnvAllowlist: []string{"HOME"}}
	for name, change := range map[string]func(*config.AgentConfig, *string, *string){
		"agent":       func(_ *config.AgentConfig, id, _ *string) { *id = "agent_short" },
		"kind":        func(v *config.AgentConfig, _, _ *string) { v.RuntimeKind = "generic" },
		"adapter":     func(v *config.AgentConfig, _, _ *string) { v.Adapter = "generic" },
		"preset":      func(v *config.AgentConfig, _, _ *string) { v.PresetVersion-- },
		"command":     func(v *config.AgentConfig, _, _ *string) { v.Command = nil },
		"profile":     func(_ *config.AgentConfig, _, profile *string) { *profile = ":workspace" },
		"duplicate":   func(v *config.AgentConfig, _, _ *string) { v.EnvAllowlist = []string{"HOME", "HOME"} },
		"invalid env": func(v *config.AgentConfig, _, _ *string) { v.EnvAllowlist = []string{"HOME=value"} },
		"secret env":  func(v *config.AgentConfig, _, _ *string) { v.EnvAllowlist = []string{"OPENAI_API_KEY"} },
	} {
		t.Run(name, func(t *testing.T) {
			value, id, profile := base, "agent_profile0001", "convenewire_governed"
			change(&value, &id, &profile)
			if digest, err := CodexConfigurationDigest(value, id, profile); !errors.Is(err, ErrProfileInvalid) || strings.TrimSpace(digest) != "" {
				t.Fatalf("digest=%q err=%v", digest, err)
			}
		})
	}
}
