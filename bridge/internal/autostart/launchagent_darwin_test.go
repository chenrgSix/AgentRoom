//go:build darwin

package autostart

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchAgentEnableDisableIsIdempotentAndContainsNoCredential(t *testing.T) {
	directory := t.TempDir()
	plistPath := filepath.Join(directory, "LaunchAgents", "bridge.plist")
	calls := 0
	controller := newLaunchAgentController(
		"/Applications/AgentRoom Bridge.app/Contents/MacOS/agentroom-bridge-desktop",
		[]string{"--background", "--config", filepath.Join(directory, "bridge.json")},
		plistPath,
		"gui/501",
		func(context.Context, string, ...string) ([]byte, error) {
			calls++
			return nil, nil
		},
	)
	state, err := controller.SetEnabled(context.Background(), true)
	if err != nil || !state.Enabled || state.PathMismatch {
		t.Fatalf("unexpected enabled state: %#v, %v", state, err)
	}
	source, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, "--background") || strings.Contains(strings.ToLower(text), "token") || strings.Contains(text, "secret") {
		t.Fatalf("unsafe or incomplete LaunchAgent: %s", text)
	}
	info, err := os.Stat(plistPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected LaunchAgent permissions: %#v, %v", info, err)
	}
	if _, err := controller.SetEnabled(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("idempotent enable launched more than one bootstrap: %d", calls)
	}
	state, err = controller.SetEnabled(context.Background(), false)
	if err != nil || state.Enabled {
		t.Fatalf("unexpected disabled state: %#v, %v", state, err)
	}
	if _, err := os.Stat(plistPath); !os.IsNotExist(err) {
		t.Fatal("disabling login startup must remove its plist")
	}
}

func TestLaunchAgentStateDetectsMovedApplication(t *testing.T) {
	directory := t.TempDir()
	plistPath := filepath.Join(directory, "bridge.plist")
	first := newLaunchAgentController("/Applications/AgentRoom Bridge.app/Contents/MacOS/agentroom-bridge-desktop", nil, plistPath, "gui/501", func(context.Context, string, ...string) ([]byte, error) { return nil, nil })
	if _, err := first.SetEnabled(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	moved := newLaunchAgentController("/Users/test/AgentRoom Bridge.app/Contents/MacOS/agentroom-bridge-desktop", nil, plistPath, "gui/501", func(context.Context, string, ...string) ([]byte, error) { return nil, nil })
	state, err := moved.State()
	if err != nil || !state.Enabled || !state.PathMismatch {
		t.Fatalf("expected moved app mismatch, got %#v, %v", state, err)
	}
}
