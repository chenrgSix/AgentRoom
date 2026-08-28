//go:build windows

package runtime

import (
	"os/exec"
	"testing"
)

func TestConfigureWindowsRuntimeCommandSuppressesConsoleWindow(t *testing.T) {
	command := exec.Command("runtime.exe")

	configureRuntimeCommand(command)

	if command.SysProcAttr == nil {
		t.Fatal("Windows Runtime command has no process attributes")
	}
	if !command.SysProcAttr.HideWindow {
		t.Fatal("Windows Runtime command can show a console window")
	}
	if command.SysProcAttr.CreationFlags&createNoWindow == 0 {
		t.Fatalf("Windows Runtime command creation flags = %#x, want CREATE_NO_WINDOW", command.SysProcAttr.CreationFlags)
	}
	if command.WaitDelay != runtimeProcessWaitDelay {
		t.Fatalf("Windows Runtime command wait delay = %s, want %s", command.WaitDelay, runtimeProcessWaitDelay)
	}
}
