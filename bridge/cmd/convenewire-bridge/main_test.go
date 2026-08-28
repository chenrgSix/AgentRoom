package main

import (
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
)

func TestArtifactCommandRequiresBoundedPublishInputs(t *testing.T) {
	for _, args := range [][]string{
		{"artifact"},
		{"artifact", "unknown"},
		{"artifact", "publish", "--type", "patch"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("run(%q) unexpectedly succeeded", args)
		}
	}
}

func TestResultCommandRequiresInlineStructuredProposal(t *testing.T) {
	for _, args := range [][]string{
		{"result"},
		{"result", "unknown"},
		{"result", "propose", "--run-id", "run_result_cli_0001"},
	} {
		if err := run(args); err == nil {
			t.Fatalf("run(%q) unexpectedly succeeded", args)
		}
	}
}

func TestConfiguredAgentIsExplicitWhenAmbiguous(t *testing.T) {
	agents := []config.AgentConfig{{Name: "Builder"}, {Name: "Reviewer"}}
	if _, err := configuredAgent(agents, ""); err == nil ||
		!strings.Contains(err.Error(), "requires --agent") {
		t.Fatalf("ambiguous Agent error = %v", err)
	}
	selected, err := configuredAgent(agents, "Reviewer")
	if err != nil || selected.Name != "Reviewer" {
		t.Fatalf("selected=%#v err=%v", selected, err)
	}
}

func TestJoinRejectsUnknownCodexSessionConflictPolicyBeforeEnrollment(t *testing.T) {
	err := join([]string{
		"--server", "http://127.0.0.1:3000",
		"--codex-session-conflict-policy", "replace_everything",
	})
	if err == nil || !strings.Contains(err.Error(), "preserve_and_retry or start_new") {
		t.Fatalf("unexpected conflict-policy validation error: %v", err)
	}
}
