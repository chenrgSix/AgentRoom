package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
}

func TestRejectsUnsafeOrAmbiguousConfig(t *testing.T) {
	valid := Config{
		ServerURL:               "https://team.example.com",
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
	invalid = valid
	invalid.Agents = append(invalid.Agents, invalid.Agents[0])
	if err := invalid.Validate(); err == nil {
		t.Fatal("expected duplicate Agent name to be rejected")
	}
}

func TestSaveWritesOwnerOnlyConfigAndRefusesOverwrite(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "nested", "bridge.json")
	value := Config{
		ServerURL: "http://127.0.0.1:3000", DeviceName: "Alice Mac",
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
	if loaded.DeviceName != "Updated Mac" {
		t.Fatalf("unexpected replacement config: %#v", loaded)
	}
	if loaded.SchemaVersion != CurrentSchemaVersion ||
		loaded.Agents[0].PresetVersion != CurrentPresetVersion {
		t.Fatalf("saved config omitted version markers: %#v", loaded)
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
	if loaded.DeviceName != "Owner Mac" || loaded.Agents[0].Name != "My Codex" ||
		loaded.Agents[0].Role != "Builder" || loaded.Agents[0].Workspace != workspace {
		t.Fatalf("Codex owner fields changed during migration: %#v", loaded.Agents[0])
	}
	if loaded.Agents[0].RuntimeKind != "codex" ||
		strings.Join(loaded.Agents[0].Command[1:], " ") != "exec --json --sandbox read-only -" {
		t.Fatalf("unexpected Codex migration: %#v", loaded.Agents[0])
	}
	pi := loaded.Agents[1]
	if pi.Name != "My Pi" || pi.Role != "Reviewer" || pi.Workspace != workspace ||
		!strings.Contains(strings.Join(pi.EnvAllowlist, " "), "ANTHROPIC_API_KEY") {
		t.Fatalf("Pi owner fields changed during migration: %#v", pi)
	}
	if pi.RuntimeKind != "pi" || pi.PresetVersion != CurrentPresetVersion ||
		strings.Join(pi.Command[1:], " ") != "--print --no-tools --no-extensions --no-skills --no-context-files --no-session" {
		t.Fatalf("legacy Pi flags were not replaced: %#v", pi)
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(onDisk, []byte(`"schemaVersion"`)) {
		t.Fatal("Load must not rewrite owner configuration implicitly")
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
