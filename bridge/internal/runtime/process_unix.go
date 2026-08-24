//go:build darwin || linux

package runtime

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const runtimeProcessWaitDelay = 250 * time.Millisecond

// configureRuntimeCommand puts each Runtime in its own process group. Killing
// only a shell process can leave its children alive with inherited output
// pipes, which makes exec.Cmd wait past the Run deadline.
func configureRuntimeCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.WaitDelay = runtimeProcessWaitDelay
	command.Cancel = func() error {
		if command.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
