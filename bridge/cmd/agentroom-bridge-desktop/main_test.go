//go:build desktop

package main

import (
	"net/url"
	"os"
	"strings"
	"testing"

	"agentroom.dev/bridge/internal/console"
	"agentroom.dev/bridge/internal/operations"
)

func TestPhaseLabelCoversDesktopTrayStates(t *testing.T) {
	tests := []struct {
		phase console.Phase
		want  string
	}{
		{console.PhaseUnconfigured, "等待配置"},
		{console.PhaseReady, "已停止"},
		{console.PhaseJoining, "正在加入"},
		{console.PhaseApproval, "等待审批"},
		{console.PhaseRunning, "连接中"},
		{console.PhaseError, "需要处理"},
	}
	for _, test := range tests {
		if got := phaseLabel(console.State{Phase: test.phase}); got != test.want {
			t.Fatalf("phase %q: got %q, want %q", test.phase, got, test.want)
		}
	}
	for _, test := range []struct {
		state operations.ConnectionState
		want  string
	}{
		{operations.ConnectionConnecting, "连接中"},
		{operations.ConnectionOnline, "在线"},
		{operations.ConnectionRetrying, "重连中"},
	} {
		if got := phaseLabel(console.State{
			Phase: console.PhaseRunning, BridgeRunning: true,
			Connection: console.ConnectionView{State: test.state},
		}); got != test.want {
			t.Fatalf("connection %q: got %q, want %q", test.state, got, test.want)
		}
	}
}

func TestDesktopPackagesRegisterDevicePairingProtocolWithoutOwningState(t *testing.T) {
	macMetadata, err := os.ReadFile("../../desktop/darwin/Info.plist")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(macMetadata), "<key>CFBundleURLSchemes</key>") ||
		!strings.Contains(string(macMetadata), "<string>agentroom</string>") {
		t.Fatal("macOS app metadata omitted the agentroom URL scheme")
	}
	windowsInstaller, err := os.ReadFile("../../desktop/windows/installer.iss")
	if err != nil {
		t.Fatal(err)
	}
	installer := string(windowsInstaller)
	for _, required := range []string{
		`Software\Classes\agentroom`, `ValueName: "URL Protocol"`,
		`AgentRoom Bridge.exe"" ""%1`, "Flags: uninsdeletekey",
	} {
		if !strings.Contains(installer, required) {
			t.Fatalf("Windows installer omitted protocol registration fragment %q", required)
		}
	}
	if strings.Contains(strings.ToLower(installer), `%appdata%\agentroom`) {
		t.Fatal("protocol registration must not turn owner state into installer-owned data")
	}
}

func TestDesktopLaunchCarriesOneValidatedPairingLinkOnlyInTheFragment(t *testing.T) {
	link := "agentroom://pair-device?origin=https%3A%2F%2Fteam.example&pairingSessionId=pairing_12345678&expiresAt=2026-08-28T12%3A00%3A00Z#claimSecret=" + strings.Repeat("s", 43)
	selected, err := pairingLinkFromLaunch("", []string{"--background", link})
	if err != nil || selected != link {
		t.Fatalf("expected protocol launch link: %q, %v", selected, err)
	}
	windowURL := consoleWindowURL("local-console-token", selected)
	parsed, err := url.Parse(windowURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("token") != "local-console-token" ||
		parsed.Query().Get("pairingLink") != "" || parsed.Fragment == "" ||
		!strings.Contains(parsed.Fragment, "pairingLink=") {
		t.Fatalf("pairing proof must stay in the WebView fragment: %s", windowURL)
	}
	if _, err := pairingLinkFromLaunch(link, []string{link}); err == nil {
		t.Fatal("multiple pairing links must be rejected")
	}
	if _, err := pairingLinkFromLaunch("agentroom://unexpected", nil); err == nil {
		t.Fatal("invalid protocol target must be rejected")
	}
}

func TestLoginArgumentsStartHiddenWithoutSecrets(t *testing.T) {
	arguments := loginArguments("/tmp/bridge.json", "/tmp/data", "/tmp/workspace")
	joined := strings.Join(arguments, " ")
	for _, expected := range []string{"--background", "--config /tmp/bridge.json", "--data-dir /tmp/data", "--workspace /tmp/workspace"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing %q in %q", expected, joined)
		}
	}
	if strings.Contains(strings.ToLower(joined), "token") || strings.Contains(joined, "secret") {
		t.Fatalf("login arguments contain a credential: %q", joined)
	}
}
