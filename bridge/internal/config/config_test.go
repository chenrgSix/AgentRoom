package config

import (
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
}
