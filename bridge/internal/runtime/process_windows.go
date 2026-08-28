package runtime

import (
	"os/exec"
	"syscall"
	"time"
)

const (
	runtimeProcessWaitDelay = 250 * time.Millisecond
	// CREATE_NO_WINDOW prevents console-subsystem Runtime launchers (including
	// npm .cmd shims) from allocating a console when the Bridge is a GUI app.
	createNoWindow uint32 = 0x08000000
)

// Keep managed Runtimes windowless and prevent inherited child pipes from
// blocking the Bridge after CommandContext terminates the process on Windows.
func configureRuntimeCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
	command.WaitDelay = runtimeProcessWaitDelay
}
