package config

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestRenameKeepsReleasedConfigAndWireIdentifiers(t *testing.T) {
	if !strings.HasSuffix(DefaultPath(), filepath.Join("agentroom", "bridge.json")) {
		t.Fatalf("released config path changed: %s", DefaultPath())
	}
	if OutputProtocolConveneWireJSONLV1 != "agentroom-jsonl-v1" {
		t.Fatalf("released output protocol changed: %s", OutputProtocolConveneWireJSONLV1)
	}
	if ServerTokenHeader != "X-AgentRoom-Server-Token" {
		t.Fatalf("released Server Token header changed: %s", ServerTokenHeader)
	}
}

func TestLoadValidConfig(t *testing.T) {
	directory := t.TempDir()
	workspace := filepath.Join(directory, "repo")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "bridge.json")
	source := `{
  "serverUrl": "http://127.0.0.1:3000",
  "deviceName": "Alice Mac",
  "dataDir": "data",
  "agents": [{
    "name": "Builder",
    "role": "Implementation",
    "adapter": "generic",
    "command": ["printf", "done"],
    "workspace": "` + workspace + `",
    "envAllowlist": ["PATH"]
  }]
}`
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DataDir != filepath.Join(directory, "data") {
		t.Fatalf("unexpected data directory: %s", loaded.DataDir)
	}
	if loaded.ShareReasoningSummaries {
		t.Fatal("missing local consent must default to false")
	}
	for _, consent := range []bool{true, false} {
		loaded.ShareReasoningSummaries = consent
		if err := Replace(path, loaded); err != nil {
			t.Fatal(err)
		}
		reloaded, err := Load(path)
		if err != nil || reloaded.ShareReasoningSummaries != consent {
			t.Fatalf("consent round trip failed: %v", err)
		}
	}
}

func TestRejectsUnsafeOrAmbiguousConfig(t *testing.T) {
	valid := Config{
		ServerURL:               "https://team.example.com",
		ServerToken:             strings.Repeat("t", 32),
		ServerCertificateSHA256: strings.Repeat("a", 64),
		DeviceName:              "Alice Mac",
		DataDir:                 t.TempDir(),
		Agents: []AgentConfig{{
			Name: "Builder", Role: "Implementation", Adapter: "generic",
			Command: []string{"agent"}, Workspace: t.TempDir(),
		}},
	}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	if valid.ResolvedTrustMode() != TrustPinnedSHA256 {
		t.Fatal("legacy fingerprint-only config must infer pinned_sha256")
	}
	systemCA := valid
	systemCA.ServerTrustMode = TrustSystemCA
	systemCA.ServerCertificateSHA256 = ""
	if err := systemCA.Validate(); err != nil {
		t.Fatalf("system CA HTTPS config should be valid: %v", err)
	}
	ambiguous := systemCA
	ambiguous.ServerCertificateSHA256 = strings.Repeat("b", 64)
	if err := ambiguous.Validate(); err == nil {
		t.Fatal("expected system_ca with a fingerprint to be rejected")
	}
	invalid := valid
	invalid.ServerURL = "http://team.example.com"
	if err := invalid.Validate(); err == nil {
		t.Fatal("expected non-loopback HTTP URL to be rejected")
	}
	for _, serverURL := range []string{
		"https://user@team.example.com",
		"https://team.example.com/api",
		"https://team.example.com?mode=private",
		"https://team.example.com#fragment",
	} {
		invalid = systemCA
		invalid.ServerURL = serverURL
		if err := invalid.Validate(); err == nil {
			t.Fatalf("expected non-origin Server URL to be rejected: %s", serverURL)
		}
	}
	invalid = valid
	invalid.Agents = append(invalid.Agents, invalid.Agents[0])
	if err := invalid.Validate(); err == nil {
		t.Fatal("expected duplicate Agent name to be rejected")
	}
	for _, token := range []string{strings.Repeat("t", 31), strings.Repeat("t", 513), " " + strings.Repeat("t", 32), strings.Repeat("t", 32) + "\n"} {
		invalid = valid
		invalid.ServerToken = token
		if err := invalid.Validate(); err == nil {
			t.Fatalf("expected invalid central Server Token length or whitespace to be rejected: %q", token)
		}
	}
}

func TestSaveWritesOwnerOnlyConfigAndRefusesOverwrite(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "nested", "bridge.json")
	value := Config{
		ServerURL: "http://127.0.0.1:3000", ServerToken: strings.Repeat("s", 32), DeviceName: "Alice Mac",
		DataDir: filepath.Join(directory, "data"),
		Agents: []AgentConfig{{
			Name: "Local Codex", Role: "Implementation", Adapter: "codex",
			Command: []string{"codex", "exec", "--json", "-"}, Workspace: directory,
		}},
	}
	if err := Save(path, value); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config permissions are %o", info.Mode().Perm())
	}
	if _, err := Load(path); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, value); err == nil {
		t.Fatal("expected existing config to prevent overwrite")
	}
	replacement := value
	replacement.DeviceName = "Updated Mac"
	if err := Replace(path, replacement); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DeviceName != "Updated Mac" || loaded.ServerToken != value.ServerToken {
		t.Fatalf("unexpected replacement config: %#v", loaded)
	}
	if loaded.SchemaVersion != CurrentSchemaVersion ||
		loaded.Agents[0].PresetVersion != CurrentPresetVersion {
		t.Fatalf("saved config omitted version markers: %#v", loaded)
	}
}

func TestMigrateVersionOneConfigurationWithoutServerToken(t *testing.T) {
	configuration, err := Migrate(Config{SchemaVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if configuration.SchemaVersion != CurrentSchemaVersion || configuration.ServerToken != "" {
		t.Fatalf("legacy configuration migration changed Token compatibility: %#v", configuration)
	}
}

func TestLoadMigratesLegacyRuntimePresetsWithoutLosingOwnerFields(t *testing.T) {
	directory := t.TempDir()
	workspace := filepath.Join(directory, "repo")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "bridge.json")
	source := `{
  "serverUrl": "http://127.0.0.1:3000",
  "deviceName": "Owner Mac",
  "dataDir": "data",
  "agents": [{
    "name": "My Codex",
    "role": "Builder",
    "adapter": "codex",
    "command": ["/usr/local/bin/codex", "exec", "--json", "--sandbox", "read-only", "-"],
    "workspace": "` + workspace + `",
    "envAllowlist": ["HOME", "PATH", "CODEX_HOME"]
  }, {
    "name": "My Pi",
    "role": "Reviewer",
    "adapter": "generic",
    "command": ["/opt/homebrew/bin/pi", "--mode", "text", "--print", "--no-session", "--approve"],
    "workspace": "` + workspace + `",
    "envAllowlist": ["HOME", "PATH", "PI_TELEMETRY", "ANTHROPIC_API_KEY"]
  }]
}`
	if err := os.WriteFile(path, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.SchemaVersion != CurrentSchemaVersion {
		t.Fatalf("legacy schema was not migrated: %#v", loaded)
	}
	if loaded.Agents[0].WorkspaceAlias != "repo" || loaded.Agents[1].WorkspaceAlias != "repo" {
		t.Fatalf("legacy Workspace aliases were not derived locally: %#v", loaded.Agents)
	}
	if loaded.DeviceName != "Owner Mac" || loaded.Agents[0].Name != "My Codex" ||
		loaded.Agents[0].Role != "Builder" || loaded.Agents[0].Workspace != workspace {
		t.Fatalf("Codex owner fields changed during migration: %#v", loaded.Agents[0])
	}
	if loaded.Agents[0].RuntimeKind != "codex" ||
		strings.Join(loaded.Agents[0].Command[1:], " ") != "app-server --listen stdio://" ||
		loaded.Agents[0].Sandbox != "read-only" ||
		loaded.Agents[0].CodexSessionConflictPolicy != CodexSessionConflictPreserveAndRetry ||
		loaded.Agents[0].PresetVersion != CurrentPresetVersion {
		t.Fatalf("unexpected Codex migration: %#v", loaded.Agents[0])
	}
	pi := loaded.Agents[1]
	if pi.Name != "My Pi" || pi.Role != "Reviewer" || pi.Workspace != workspace ||
		!strings.Contains(strings.Join(pi.EnvAllowlist, " "), "ANTHROPIC_API_KEY") {
		t.Fatalf("Pi owner fields changed during migration: %#v", pi)
	}
	if pi.RuntimeKind != "pi" || pi.PresetVersion != CurrentPresetVersion ||
		strings.Join(pi.Command[1:], " ") != "--mode json --print --approve" {
		t.Fatalf("legacy Pi transport changed owner permissions: %#v", pi)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(onDisk, []byte(`"schemaVersion"`)) {
		t.Fatal("Load must not rewrite owner configuration implicitly")
	}
}

func TestMigrateUpgradesVersionOnePiPresetAndKeepsLocalPolicy(t *testing.T) {
	configuration, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion, Agents: []AgentConfig{{
		Name: "Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi", PresetVersion: 1,
		Command:   []string{"/usr/local/bin/pi", "--print", "--no-tools", "--no-session"},
		Workspace: t.TempDir(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	pi := configuration.Agents[0]
	if pi.PresetVersion != CurrentPresetVersion ||
		strings.Join(pi.Command[1:], " ") != "--mode json --print --no-tools" {
		t.Fatalf("version one Pi preset was not upgraded: %#v", pi)
	}
}

func TestMigrateVersionThreeCodexPresetKeepsOwnerSandbox(t *testing.T) {
	configuration, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion, Agents: []AgentConfig{{
		Name: "Codex", Role: "Builder", Adapter: "codex", RuntimeKind: "codex", PresetVersion: 3,
		Command:   []string{"/usr/local/bin/codex", "exec", "--json", "--sandbox", "read-only", "-"},
		Workspace: t.TempDir(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	codex := configuration.Agents[0]
	if codex.PresetVersion != CurrentPresetVersion || codex.Sandbox != "read-only" ||
		codex.CodexSessionConflictPolicy != CodexSessionConflictPreserveAndRetry ||
		strings.Join(codex.Command[1:], " ") != "app-server --listen stdio://" {
		t.Fatalf("version three Codex preset was not upgraded safely: %#v", codex)
	}
}

func TestCodexSessionConflictPolicyValidation(t *testing.T) {
	base := AgentConfig{
		Name: "Codex", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
		PresetVersion: CurrentPresetVersion, Command: CodexPresetCommand("/usr/local/bin/codex"),
		Workspace: t.TempDir(), Sandbox: "workspace-write",
	}
	if err := base.validate(); err != nil ||
		base.ResolvedCodexSessionConflictPolicy() != CodexSessionConflictPreserveAndRetry {
		t.Fatalf("default Codex conflict policy was rejected: policy=%q err=%v", base.ResolvedCodexSessionConflictPolicy(), err)
	}
	startNew := base
	startNew.CodexSessionConflictPolicy = CodexSessionConflictStartNew
	if err := startNew.validate(); err != nil {
		t.Fatalf("start-new Codex conflict policy was rejected: %v", err)
	}
	unknown := base
	unknown.CodexSessionConflictPolicy = "replace_everything"
	if err := unknown.validate(); err == nil {
		t.Fatal("unknown Codex conflict policy was accepted")
	}
	pi := base
	pi.Adapter = "generic"
	pi.RuntimeKind = "pi"
	pi.CodexSessionConflictPolicy = CodexSessionConflictStartNew
	if err := pi.validate(); err == nil {
		t.Fatal("Pi was allowed to claim a Codex conflict policy")
	}
}

func TestMigrateVersionThreePiPresetPreservesCustomTransport(t *testing.T) {
	command := []string{"/custom/pi-protocol-helper", "--owner-flag", "custom value"}
	configuration, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion, Agents: []AgentConfig{{
		Name: "Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi", PresetVersion: 3,
		Command: append([]string(nil), command...), Workspace: t.TempDir(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	pi := configuration.Agents[0]
	if pi.PresetVersion != CurrentPresetVersion || !slices.Equal(pi.Command, command) {
		t.Fatalf("version three Pi custom transport changed during migration: %#v", pi)
	}
}

func TestMigrateVersionTwoPiPresetDropsProductRestrictionsOnly(t *testing.T) {
	configuration, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion, Agents: []AgentConfig{{
		Name: "Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi", PresetVersion: 2,
		Command: []string{
			"/usr/local/bin/pi", "--mode", "json", "--print", "--no-tools", "--no-extensions",
			"--no-skills", "--no-context-files", "--no-session", "--approve", "--tools", "read,grep",
		},
		Workspace: t.TempDir(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	pi := configuration.Agents[0]
	if pi.PresetVersion != CurrentPresetVersion ||
		strings.Join(pi.Command[1:], " ") != "--mode json --print --approve --tools read,grep" {
		t.Fatalf("version two Pi restrictions were not retired safely: %#v", pi)
	}
}

func TestMigrateVersionFourPiPresetReplacesConflictingSessionFlags(t *testing.T) {
	configuration, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion, Agents: []AgentConfig{{
		Name: "Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi", PresetVersion: 4,
		Command: []string{
			"/usr/local/bin/pi", "--mode", "json", "--print", "--no-session",
			"--session-id", "owner-session", "--name=Owner session", "--approve",
		},
		Workspace: t.TempDir(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	pi := configuration.Agents[0]
	if pi.PresetVersion != CurrentPresetVersion ||
		strings.Join(pi.Command[1:], " ") != "--mode json --print --approve" {
		t.Fatalf("version four Pi session flags were not replaced safely: %#v", pi)
	}
}

func TestMigrateVersionFourPiPresetPreservesArgumentsAfterOptionTerminator(t *testing.T) {
	command := []string{
		"/custom/pi-helper", "--mode", "json", "--print", "--no-session",
		"--", "--session-id", "helper-value", "--name=Helper value",
	}
	configuration, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion, Agents: []AgentConfig{{
		Name: "Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi", PresetVersion: 4,
		Command: command, Workspace: t.TempDir(),
	}}})
	if err != nil {
		t.Fatal(err)
	}
	pi := configuration.Agents[0]
	expected := []string{
		"/custom/pi-helper", "--mode", "json", "--print",
		"--", "--session-id", "helper-value", "--name=Helper value",
	}
	if !slices.Equal(pi.Command, expected) {
		t.Fatalf("Pi helper arguments after -- changed during migration: %#v", pi.Command)
	}
}

func TestMigrateRejectsFutureConfigAndPresetVersions(t *testing.T) {
	if _, err := Migrate(Config{SchemaVersion: CurrentSchemaVersion + 1}); err == nil {
		t.Fatal("expected a future config schema to fail closed")
	}
	if _, err := Migrate(Config{Agents: []AgentConfig{{
		PresetVersion: CurrentPresetVersion + 1,
	}}}); err == nil {
		t.Fatal("expected a future Runtime preset to fail closed")
	}
}

func TestWorkspaceAliasMigrationAndValidationStayPathFree(t *testing.T) {
	workspace := filepath.Join(t.TempDir(), "Payments API")
	migrated, err := Migrate(Config{Agents: []AgentConfig{{
		Name: "Builder", Role: "Implementation", Adapter: "generic", RuntimeKind: "generic",
		Command: []string{"/usr/local/bin/agent"}, Workspace: workspace,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if migrated.Agents[0].WorkspaceAlias != "Payments API" {
		t.Fatalf("unexpected migrated Workspace alias: %#v", migrated.Agents[0])
	}
	if migrated.Agents[0].WorkspaceFilesystemPolicy() != "runtime-managed" ||
		migrated.Agents[0].WorkspaceNetworkPolicy() != "runtime-managed" {
		t.Fatalf("local policies were not closed: %#v", migrated.Agents[0])
	}
	for _, invalid := range []string{" users ", "../private", `Users\\private`, ".", "line\nbreak"} {
		candidate := migrated.Agents[0]
		candidate.WorkspaceAlias = invalid
		if err := candidate.validate(); err == nil {
			t.Fatalf("unsafe Workspace alias was accepted: %q", invalid)
		}
	}
}

func TestAgentConfigScopesStructuredOutputProtocolToGenericRuntime(t *testing.T) {
	base := AgentConfig{
		Name: "Generic", Role: "Worker", Adapter: "generic", RuntimeKind: "generic",
		Command: []string{"/usr/local/bin/runtime"}, Workspace: t.TempDir(),
		OutputProtocol: OutputProtocolConveneWireJSONLV1,
	}
	if err := base.validate(); err != nil {
		t.Fatalf("valid Generic output protocol was rejected: %v", err)
	}
	unknown := base
	unknown.OutputProtocol = "arbitrary-stdout"
	if err := unknown.validate(); err == nil {
		t.Fatal("unknown Generic output protocol was accepted")
	}
	pi := base
	pi.RuntimeKind = "pi"
	if err := pi.validate(); err == nil {
		t.Fatal("Pi was allowed to claim the Generic output protocol")
	}
}
