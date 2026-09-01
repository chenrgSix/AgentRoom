//go:build darwin || linux

package runtime

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	contracts "convenewire.dev/contracts/generated/go"
)

func TestGovernedUnixRuntimeCannotExecuteBeforeDurableObservation(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, "runtime-started")
	lockFile, err := os.OpenFile(filepath.Join(directory, "runtime.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	lease := &governedProcessLeaseStub{lockFile: lockFile, startedCheck: func() error {
		if _, err := os.Stat(marker); err == nil {
			return errors.New("Runtime executed before process observation")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}}
	tracker := &governedProcessTrackerStub{lease: lease}
	command, managed, err := newRuntimeCommand(context.Background(),
		[]string{"/bin/sh", "-c", "printf started > \"$1\"; printf ready", "runtime", marker},
		tracker, governedProcessIdentityFixture())
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := managed.Start(); err != nil {
		t.Fatal(err)
	}
	raw, readErr := io.ReadAll(output)
	waitErr := managed.Wait()
	if readErr != nil || string(raw) != "ready" || waitErr == nil {
		t.Fatalf("output=%q read=%v wait=%v", raw, readErr, waitErr)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal(err)
	}
	if tracker.prepared != 1 || lease.started != 1 || lease.finished != 1 || lease.abandoned != 0 ||
		lease.observation.PID <= 0 || lease.observation != lease.finishedRecord {
		t.Fatalf("tracker=%+v lease=%+v", tracker, lease)
	}
}

func TestGovernedUnixRuntimeStartFailureNeverReleasesConfiguredRuntime(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, "runtime-started")
	lockFile, err := os.OpenFile(filepath.Join(directory, "runtime.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	denied := errors.New("durable process observation failed")
	lease := &governedProcessLeaseStub{lockFile: lockFile, startErr: denied}
	tracker := &governedProcessTrackerStub{lease: lease}
	_, managed, err := newRuntimeCommand(context.Background(),
		[]string{"/bin/sh", "-c", "printf started > \"$1\"", "runtime", marker},
		tracker, governedProcessIdentityFixture())
	if err != nil {
		t.Fatal(err)
	}
	if err := managed.Start(); !errors.Is(err, denied) {
		t.Fatalf("error=%v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("configured Runtime crossed denied gate: %v", err)
	}
	if lease.started != 1 || lease.finished != 1 || lease.abandoned != 0 {
		t.Fatalf("lease=%+v", lease)
	}
}

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
