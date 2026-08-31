package identity

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
)

func TestLookupConfiguredNeverCreatesOrRepairsIdentities(t *testing.T) {
	dir := t.TempDir()
	agents := []config.AgentConfig{{Name: "Builder"}}
	const id = "agent_lookup0001"
	file := filepath.Join(dir, filename)
	if _, err := LookupConfigured(dir, agents, id); err == nil {
		t.Fatal("missing identity accepted")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("lookup created identity file")
	}
	for _, source := range []string{
		`{"Builder":"agent_lookup0001"}`,
		`{"Builder":"agent_lookup0001","old-name":"agent_lookup0001"}`,
	} {
		if err := os.WriteFile(file, []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
		selected, err := LookupConfigured(dir, agents, id)
		if err != nil || selected.Name != "Builder" {
			t.Fatal(err)
		}
		if _, err := LookupConfigured(dir, agents, "agent_foreign0001"); err == nil {
			t.Fatal("foreign identity accepted")
		}
		after, _ := os.ReadFile(file)
		if string(after) != source {
			t.Fatal("lookup rewrote identities")
		}
	}
	for _, source := range []string{
		`{}`, `null`, `{"Builder":null}`, `{"Builder":1}`, `{"Builder":"agent_lookup0001","Builder":"agent_lookup0001"}`,
		`{"Builder":"agent_lookup0001"}{}`, `{"Builder":"agent_\ud800"}`, strings.Repeat(" ", (1<<20)+1),
	} {
		if err := os.WriteFile(file, []byte(source), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LookupConfigured(dir, agents, id); err == nil {
			t.Fatal("ambiguous identities accepted")
		}
		after, _ := os.ReadFile(file)
		if string(after) != source {
			t.Fatal("lookup repaired identities")
		}
	}
	if err := os.WriteFile(file, []byte(`{"Builder":"agent_lookup0001","Reviewer":"agent_lookup0001"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LookupConfigured(dir, append(agents, config.AgentConfig{Name: "Reviewer"}), id); err == nil {
		t.Fatal("duplicate active identity accepted")
	}
}

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

func TestNewAgentCanReuseRenamedAliasWithoutSharingIdentity(t *testing.T) {
	directory := t.TempDir()
	before, err := LoadOrCreate(directory, []config.AgentConfig{{Name: "A"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := BindName(directory, "B", before["A"]); err != nil {
		t.Fatal(err)
	}
	current := []config.AgentConfig{{Name: "B"}}
	created, err := AllocateNew(directory, current, "A")
	if err != nil || created == before["A"] {
		t.Fatalf("creation reused active alias: %s, %v", created, err)
	}
	// Model a failed configuration replacement: current roster still contains B.
	retry, err := AllocateNew(directory, current, "A")
	if err != nil || retry != created {
		t.Fatalf("reservation changed on retry: %s, %v", retry, err)
	}
	after, err := LoadOrCreate(directory, append(current, config.AgentConfig{Name: "A"}))
	if err != nil {
		t.Fatal(err)
	}
	if after["B"] != before["A"] || after["A"] != created {
		t.Fatal("reload changed identity")
	}
	if _, err := AllocateNew(directory, current, "B"); err == nil {
		t.Fatal("active name accepted as new")
	}
}

func TestAmbiguousConfiguredIdentitiesFailClosedWithoutRewriting(t *testing.T) {
	directory := t.TempDir()
	before, err := LoadOrCreate(directory, []config.AgentConfig{{Name: "A"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := BindName(directory, "B", before["A"]); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, filename)
	bytesBefore, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreate(directory, []config.AgentConfig{{Name: "A"}, {Name: "B"}}); err == nil {
		t.Fatal("ambiguous roster was accepted")
	}
	bytesAfter, err := os.ReadFile(file)
	if err != nil || string(bytesBefore) != string(bytesAfter) {
		t.Fatal("ambiguous identity was rewritten")
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
