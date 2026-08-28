//go:build darwin || linux

package runtime

import (
	"context"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	contracts "convenewire.dev/contracts/generated/go"
)

func TestGenericAdapterDeadlineTerminatesRuntimeProcessGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	started := time.Now()
	var terminal Event
	adapter := GenericAdapter{Config: config.AgentConfig{
		Adapter: "generic", Command: []string{"/bin/sh", "-c", "sleep 2"},
		Workspace: t.TempDir(),
	}}

	err := adapter.Execute(ctx, Request{}, func(_ context.Context, event Event) error {
		if event.Status != nil && *event.Status != contracts.Working {
			terminal = event
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed ||
		terminal.Error == nil || terminal.Error.Code != "RUNTIME_TIMEOUT" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Runtime process group survived deadline for %s", elapsed)
	}
}
