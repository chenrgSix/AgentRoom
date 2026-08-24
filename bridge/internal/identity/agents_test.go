package identity

import (
	"testing"

	"agentroom.dev/bridge/internal/config"
)

func TestAgentIdentitySurvivesReload(t *testing.T) {
	directory := t.TempDir()
	agents := []config.AgentConfig{{Name: "Builder"}, {Name: "Reviewer"}}
	first, err := LoadOrCreate(directory, agents)
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadOrCreate(directory, agents)
	if err != nil {
		t.Fatal(err)
	}
	if first["Builder"] == "" || first["Builder"] != second["Builder"] {
		t.Fatal("Agent identity did not remain stable")
	}
}

func TestBindNamePreservesIdentityAcrossRename(t *testing.T) {
	directory := t.TempDir()
	before, err := LoadOrCreate(directory, []config.AgentConfig{{Name: "Builder"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := BindName(directory, "Renamed Builder", before["Builder"]); err != nil {
		t.Fatal(err)
	}
	after, err := LoadOrCreate(directory, []config.AgentConfig{{Name: "Renamed Builder"}})
	if err != nil {
		t.Fatal(err)
	}
	if after["Renamed Builder"] != before["Builder"] {
		t.Fatal("renaming the Agent changed its immutable identity")
	}
}
