//go:build desktop

package main

import (
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
