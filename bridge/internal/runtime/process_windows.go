package runtime

import (
	"os/exec"
	"time"
)

const runtimeProcessWaitDelay = 250 * time.Millisecond

// WaitDelay prevents inherited child pipes from keeping the Bridge blocked
// after CommandContext terminates the configured Runtime process on Windows.
func configureRuntimeCommand(command *exec.Cmd) {
	command.WaitDelay = runtimeProcessWaitDelay
}
