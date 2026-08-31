package admission

import (
	"encoding/json"
	"os"
	"slices"
	"strings"

	"convenewire.dev/bridge/internal/config"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var codexEnvironmentNames = map[string]bool{
	"HOME": true, "PATH": true, "CODEX_HOME": true, "LANG": true,
	"LC_ALL": true, "LC_CTYPE": true, "TERM": true,
}

// CodexConfigurationDigest binds the local execution-bearing parts of one
// configured Agent. Display metadata and its ordinary Workspace are excluded:
// governed execution receives a separately prepared exact worktree. Environment
// values and local paths are never serialized into the returned digest.
func CodexConfigurationDigest(agent config.AgentConfig, stableAgentID, permissionProfile string) (string, error) {
	if !agentID.MatchString(stableAgentID) || agent.RuntimeKind != CodexRuntimeKind || agent.Adapter != "codex" ||
		agent.PresetVersion != config.CurrentPresetVersion || agent.Sandbox != "workspace-write" ||
		len(agent.Command) == 0 || strings.TrimSpace(agent.Command[0]) == "" || !permissionProfileName.MatchString(permissionProfile) {
		return "", ErrProfileInvalid
	}
	command := append([]string{}, agent.Command...)
	environment := append([]string{}, agent.EnvAllowlist...)
	slices.Sort(environment)
	for index, name := range environment {
		if name == "" || strings.Contains(name, "=") || !codexEnvironmentNames[name] || (index > 0 && name == environment[index-1]) {
			return "", ErrProfileInvalid
		}
	}
	value := struct {
		Version                    int      `json:"version"`
		AgentID                    string   `json:"agentId"`
		RuntimeKind                string   `json:"runtimeKind"`
		Adapter                    string   `json:"adapter"`
		PresetVersion              int      `json:"presetVersion"`
		Command                    []string `json:"command"`
		Sandbox                    string   `json:"sandbox"`
		CodexSessionConflictPolicy string   `json:"codexSessionConflictPolicy"`
		EnvironmentNames           []string `json:"environmentNames"`
		PermissionProfile          string   `json:"permissionProfile"`
	}{Version: 1, AgentID: stableAgentID, RuntimeKind: agent.RuntimeKind, Adapter: agent.Adapter,
		PresetVersion: agent.PresetVersion, Command: command, Sandbox: agent.Sandbox,
		CodexSessionConflictPolicy: string(agent.ResolvedCodexSessionConflictPolicy()), EnvironmentNames: environment,
		PermissionProfile: permissionProfile}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", ErrProfileInvalid
	}
	return wire.ExecutionDigest(raw)
}

func codexProbeEnvironment(names []string) ([]string, error) {
	ordered := append([]string{}, names...)
	slices.Sort(ordered)
	result := make([]string, 0, len(ordered))
	for index, name := range ordered {
		if name == "" || strings.Contains(name, "=") || !codexEnvironmentNames[name] || (index > 0 && name == ordered[index-1]) {
			return nil, ErrProfileInvalid
		}
		if value, ok := os.LookupEnv(name); ok {
			result = append(result, name+"="+value)
		}
	}
	return result, nil
}
