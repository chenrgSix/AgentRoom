//go:build desktop

package main

import (
	"testing"

	"agentroom.dev/bridge/internal/console"
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
		{console.PhaseRunning, "运行中"},
		{console.PhaseError, "需要处理"},
	}
	for _, test := range tests {
		if got := phaseLabel(console.State{Phase: test.phase}); got != test.want {
			t.Fatalf("phase %q: got %q, want %q", test.phase, got, test.want)
		}
	}
}
