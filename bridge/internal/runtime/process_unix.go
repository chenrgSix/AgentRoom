//go:build darwin || linux

package runtime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const runtimeProcessWaitDelay = 250 * time.Millisecond

const runtimeGateArgument = "__convenewire_runtime_gate_v1__"

var runtimeGateToken = []byte("convenewire-runtime-start-v1\n")

func init() {
	if len(os.Args) >= 3 && os.Args[1] == runtimeGateArgument {
		runUnixRuntimeGate(os.Args[2:])
	}
}

// configureRuntimeCommand puts each Runtime in its own process group. Killing
// only a shell process can leave its children alive with inherited output
// pipes, which makes exec.Cmd wait past the Run deadline.
func configureRuntimeCommand(command *exec.Cmd) runtimeCommand {
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
	return command
}

type governedUnixRuntimeCommand struct {
	command   *exec.Cmd
	managed   runtimeCommand
	lease     GovernedProcessLease
	gateRead  *os.File
	gateWrite *os.File
	observed  GovernedProcessObservation
}

func configureGovernedRuntimeCommand(ctx context.Context, args []string, tracker GovernedProcessTracker,
	identity GovernedProcessIdentity) (*exec.Cmd, runtimeCommand, error) {
	executable, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	lease, err := tracker.PrepareProcess(identity)
	if err != nil {
		return nil, nil, err
	}
	lockFile := lease.InheritedLockFile()
	if lockFile == nil {
		return nil, nil, errors.Join(ErrGovernedProcessInvalid, lease.Abandon())
	}
	gateRead, gateWrite, err := os.Pipe()
	if err != nil {
		return nil, nil, errors.Join(err, lease.Abandon())
	}
	helperArgs := append([]string{runtimeGateArgument}, args...)
	command := exec.CommandContext(ctx, executable, helperArgs...)
	command.ExtraFiles = []*os.File{gateRead, lockFile}
	managed := configureRuntimeCommand(command)
	return command, &governedUnixRuntimeCommand{command: command, managed: managed, lease: lease,
		gateRead: gateRead, gateWrite: gateWrite}, nil
}

func (c *governedUnixRuntimeCommand) Start() error {
	if err := c.managed.Start(); err != nil {
		_ = c.gateRead.Close()
		_ = c.gateWrite.Close()
		return errors.Join(err, c.lease.Abandon())
	}
	c.observed = GovernedProcessObservation{PID: c.command.Process.Pid,
		PlatformIdentity: fmt.Sprintf("process-group:%d", c.command.Process.Pid)}
	if err := c.lease.Started(c.observed); err != nil {
		return c.terminateAfterStart(err)
	}
	if err := c.gateRead.Close(); err != nil {
		return c.terminateAfterStart(err)
	}
	_, writeErr := c.gateWrite.Write(runtimeGateToken)
	closeErr := c.gateWrite.Close()
	if writeErr != nil || closeErr != nil {
		return c.terminateAfterStart(errors.Join(writeErr, closeErr))
	}
	return nil
}

func (c *governedUnixRuntimeCommand) Wait() error {
	waitErr := c.managed.Wait()
	killErr := syscall.Kill(-c.observed.PID, syscall.SIGKILL)
	if errors.Is(killErr, syscall.ESRCH) {
		killErr = nil
	}
	return errors.Join(waitErr, killErr, c.lease.Finished(c.observed))
}

func (c *governedUnixRuntimeCommand) Run() error {
	if err := c.Start(); err != nil {
		return err
	}
	return c.Wait()
}

func (c *governedUnixRuntimeCommand) terminateAfterStart(cause error) error {
	_ = c.gateRead.Close()
	_ = c.gateWrite.Close()
	if c.command.Cancel != nil {
		_ = c.command.Cancel()
	}
	waitErr := c.managed.Wait()
	return errors.Join(cause, waitErr, c.lease.Finished(c.observed))
}

func runUnixRuntimeGate(args []string) {
	if syscall.Getpgrp() != os.Getpid() {
		os.Exit(125)
	}
	gate := os.NewFile(3, "convenewire-runtime-gate")
	lock := os.NewFile(4, "convenewire-runtime-lock")
	if gate == nil || lock == nil {
		os.Exit(125)
	}
	defer lock.Close()
	lockInfo, lockErr := lock.Stat()
	received, err := io.ReadAll(io.LimitReader(gate, int64(len(runtimeGateToken)+1)))
	_ = gate.Close()
	if lockErr != nil || !lockInfo.Mode().IsRegular() || err != nil ||
		!bytes.Equal(received, runtimeGateToken) || len(args) == 0 {
		os.Exit(125)
	}
	command := exec.Command(args[0], args[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	_ = command.Run()
	// The helper deliberately terminates its own process group after the direct
	// Runtime exits. This prevents daemonized descendants from outliving the
	// durable lock even if the Bridge itself disappeared while the Runtime ran.
	_ = syscall.Kill(-syscall.Getpgrp(), syscall.SIGKILL)
	os.Exit(125)
}
