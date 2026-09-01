//go:build windows

package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const (
	windowsJobParentHelper = "CONVENEWIRE_TEST_WINDOWS_JOB_PARENT"
	windowsJobChildHelper  = "CONVENEWIRE_TEST_WINDOWS_JOB_CHILD"
	windowsJobChildStarted = "CONVENEWIRE_TEST_WINDOWS_JOB_CHILD_STARTED"
	windowsJobParentReady  = "CONVENEWIRE_TEST_WINDOWS_JOB_PARENT_READY"
	windowsJobEscaped      = "CONVENEWIRE_TEST_WINDOWS_JOB_ESCAPED"
	windowsGovernedHelper  = "CONVENEWIRE_TEST_WINDOWS_GOVERNED_HELPER"
	windowsGovernedMarker  = "CONVENEWIRE_TEST_WINDOWS_GOVERNED_MARKER"
)

func TestGovernedWindowsRuntimeCannotResumeBeforeDurableObservation(t *testing.T) {
	if os.Getenv(windowsGovernedHelper) == "1" {
		if err := os.WriteFile(os.Getenv(windowsGovernedMarker), []byte("started"), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	directory := t.TempDir()
	marker := filepath.Join(directory, "runtime-started")
	lease := &governedProcessLeaseStub{startedCheck: func() error {
		if _, err := os.Stat(marker); err == nil {
			return errors.New("Runtime resumed before process observation")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}}
	tracker := &governedProcessTrackerStub{lease: lease}
	command, managed, err := newRuntimeCommand(context.Background(),
		[]string{os.Args[0], "-test.run=^TestGovernedWindowsRuntimeCannotResumeBeforeDurableObservation$"},
		tracker, governedProcessIdentityFixture())
	if err != nil {
		t.Fatal(err)
	}
	command.Env = append(os.Environ(), windowsGovernedHelper+"=1", windowsGovernedMarker+"="+marker)
	if err := managed.Run(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal(err)
	}
	if lease.started != 1 || lease.finished != 1 || lease.observation.PID <= 0 ||
		lease.observation.PlatformIdentity == "" || lease.observation != lease.finishedRecord {
		t.Fatalf("lease=%+v", lease)
	}
}

func TestGovernedWindowsObservationFailureNeverResumesRuntime(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, "runtime-started")
	denied := errors.New("durable process observation failed")
	lease := &governedProcessLeaseStub{startErr: denied}
	tracker := &governedProcessTrackerStub{lease: lease}
	command, managed, err := newRuntimeCommand(context.Background(),
		[]string{os.Args[0], "-test.run=^TestGovernedWindowsRuntimeCannotResumeBeforeDurableObservation$"},
		tracker, governedProcessIdentityFixture())
	if err != nil {
		t.Fatal(err)
	}
	command.Env = append(os.Environ(), windowsGovernedHelper+"=1", windowsGovernedMarker+"="+marker)
	if err := managed.Start(); !errors.Is(err, denied) {
		t.Fatalf("error=%v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("configured Runtime crossed denied gate: %v", err)
	}
	if lease.started != 1 || lease.finished != 1 {
		t.Fatalf("lease=%+v", lease)
	}
}

func TestConfigureWindowsRuntimeCommandSuppressesConsoleWindow(t *testing.T) {
	command := exec.Command("runtime.exe")

	_ = configureRuntimeCommand(command)

	if command.SysProcAttr == nil {
		t.Fatal("Windows Runtime command has no process attributes")
	}
	if !command.SysProcAttr.HideWindow {
		t.Fatal("Windows Runtime command can show a console window")
	}
	if command.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("Windows Runtime command creation flags = %#x, want CREATE_NO_WINDOW", command.SysProcAttr.CreationFlags)
	}
	if command.SysProcAttr.CreationFlags&windows.CREATE_SUSPENDED == 0 {
		t.Fatalf("Windows Runtime command creation flags = %#x, want CREATE_SUSPENDED", command.SysProcAttr.CreationFlags)
	}
	if command.WaitDelay != runtimeProcessWaitDelay {
		t.Fatalf("Windows Runtime command wait delay = %s, want %s", command.WaitDelay, runtimeProcessWaitDelay)
	}
}

func TestWindowsRuntimeJobTerminatesGrandchild(t *testing.T) {
	if os.Getenv(windowsJobChildHelper) == "1" {
		if err := os.WriteFile(os.Getenv(windowsJobChildStarted), []byte("started"), 0o600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(750 * time.Millisecond)
		if err := os.WriteFile(os.Getenv(windowsJobEscaped), []byte("escaped"), 0o600); err != nil {
			t.Fatal(err)
		}
		return
	}
	if os.Getenv(windowsJobParentHelper) == "1" {
		child := exec.Command(os.Args[0], "-test.run=^TestWindowsRuntimeJobTerminatesGrandchild$")
		child.Env = append(os.Environ(), windowsJobChildHelper+"=1")
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		defer child.Process.Kill()
		if err := waitForWindowsJobMarker(os.Getenv(windowsJobChildStarted), 5*time.Second); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(os.Getenv(windowsJobParentReady), []byte("ready"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := child.Wait(); err != nil {
			t.Fatal(err)
		}
		return
	}

	directory := t.TempDir()
	childStarted := filepath.Join(directory, "child-started")
	parentReady := filepath.Join(directory, "parent-ready")
	escaped := filepath.Join(directory, "escaped")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	process := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestWindowsRuntimeJobTerminatesGrandchild$")
	process.Env = append(
		os.Environ(),
		windowsJobParentHelper+"=1",
		windowsJobChildStarted+"="+childStarted,
		windowsJobParentReady+"="+parentReady,
		windowsJobEscaped+"="+escaped,
	)
	managed := configureRuntimeCommand(process)
	if err := managed.Start(); err != nil {
		t.Fatal(err)
	}
	if err := waitForWindowsJobMarker(parentReady, 5*time.Second); err != nil {
		cancel()
		_ = managed.Wait()
		t.Fatal(err)
	}

	cancel()
	waitResult := make(chan error, 1)
	go func() {
		waitResult <- managed.Wait()
	}()
	select {
	case err := <-waitResult:
		if err == nil {
			t.Fatal("canceled Runtime process returned success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Runtime process tree did not terminate after cancellation")
	}

	time.Sleep(time.Second)
	if _, err := os.Stat(escaped); err == nil {
		t.Fatal("Runtime grandchild survived Job Object cancellation")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func waitForWindowsJobMarker(path string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("timed out waiting for %s", filepath.Base(path))
}
