package config

import (
	"os"
	"path/filepath"
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
		ServerURL:  "https://team.example.com",
		DeviceName: "Alice Mac",
		DataDir:    t.TempDir(),
		Agents: []AgentConfig{{
			Name: "Builder", Role: "Implementation", Adapter: "generic",
			Command: []string{"agent"}, Workspace: t.TempDir(),
		}},
	}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
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
