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
)

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
