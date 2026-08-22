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
