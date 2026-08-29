//go:build windows

package runtime

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	runtimeProcessWaitDelay = 250 * time.Millisecond
	// CREATE_NO_WINDOW prevents console-subsystem Runtime launchers (including
	// npm .cmd shims) from allocating a console when the Bridge is a GUI app.
	createNoWindow uint32 = windows.CREATE_NO_WINDOW
)

// windowsRuntimeCommand owns a Job Object for one Runtime process tree. The
// process starts suspended so it cannot create an untracked child between
// CreateProcess and AssignProcessToJobObject.
type windowsRuntimeCommand struct {
	command *exec.Cmd

	mu  sync.Mutex
	job windows.Handle
}

// Keep managed Runtimes windowless and make both cancellation and normal
// teardown terminate the complete Runtime process tree.
func configureRuntimeCommand(command *exec.Cmd) runtimeCommand {
	managed := &windowsRuntimeCommand{command: command}
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
		CreationFlags: createNoWindow |
			windows.CREATE_SUSPENDED,
	}
	command.WaitDelay = runtimeProcessWaitDelay
	command.Cancel = managed.cancel
	return managed
}

func (command *windowsRuntimeCommand) Start() error {
	command.mu.Lock()

	job, err := createRuntimeJob()
	if err != nil {
		command.mu.Unlock()
		return err
	}
	command.job = job
	if err := command.command.Start(); err != nil {
		closeError := command.closeJobLocked()
		command.mu.Unlock()
		if closeError != nil {
			return errors.Join(err, fmt.Errorf("close Runtime Job Object: %w", closeError))
		}
		return err
	}

	if err := command.assignProcessLocked(); err != nil {
		_ = command.command.Process.Kill()
		closeError := command.closeJobLocked()
		command.mu.Unlock()
		_ = command.command.Wait()
		if closeError != nil {
			err = errors.Join(err, fmt.Errorf("close Runtime Job Object: %w", closeError))
		}
		return fmt.Errorf("assign Runtime process tree: %w", err)
	}
	if err := resumeSuspendedProcess(uint32(command.command.Process.Pid)); err != nil {
		_ = windows.TerminateJobObject(command.job, 1)
		closeError := command.closeJobLocked()
		command.mu.Unlock()
		_ = command.command.Wait()
		if closeError != nil {
			err = errors.Join(err, fmt.Errorf("close Runtime Job Object: %w", closeError))
		}
		return fmt.Errorf("resume Runtime process: %w", err)
	}

	command.mu.Unlock()
	return nil
}

func (command *windowsRuntimeCommand) Wait() error {
	waitError := command.command.Wait()

	command.mu.Lock()
	closeError := command.closeJobLocked()
	command.mu.Unlock()
	if waitError == nil && closeError != nil {
		return fmt.Errorf("close Runtime Job Object: %w", closeError)
	}
	return waitError
}

func (command *windowsRuntimeCommand) Run() error {
	if err := command.Start(); err != nil {
		return err
	}
	return command.Wait()
}

func (command *windowsRuntimeCommand) cancel() error {
	command.mu.Lock()
	defer command.mu.Unlock()
	if command.job != 0 {
		return windows.TerminateJobObject(command.job, 1)
	}
	if command.command.Process == nil {
		return os.ErrProcessDone
	}
	return command.command.Process.Kill()
}

func (command *windowsRuntimeCommand) assignProcessLocked() error {
	var assignError error
	err := command.command.Process.WithHandle(func(handle uintptr) {
		assignError = windows.AssignProcessToJobObject(command.job, windows.Handle(handle))
	})
	if err != nil {
		return err
	}
	return assignError
}

func (command *windowsRuntimeCommand) closeJobLocked() error {
	if command.job == 0 {
		return nil
	}
	err := windows.CloseHandle(command.job)
	command.job = 0
	return err
}

func createRuntimeJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create Runtime Job Object: %w", err)
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)),
		uint32(unsafe.Sizeof(limits)),
	); err != nil {
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("configure Runtime Job Object: %w", err)
	}
	return job, nil
}

func resumeSuspendedProcess(processID uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ThreadEntry32{Size: uint32(unsafe.Sizeof(windows.ThreadEntry32{}))}
	err = windows.Thread32First(snapshot, &entry)
	resumed := 0
	for err == nil {
		if entry.OwnerProcessID == processID {
			thread, openError := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if openError != nil {
				return openError
			}
			_, resumeError := windows.ResumeThread(thread)
			closeError := windows.CloseHandle(thread)
			if resumeError != nil {
				return resumeError
			}
			if closeError != nil {
				return closeError
			}
			resumed++
		}
		err = windows.Thread32Next(snapshot, &entry)
	}
	if err != nil && !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	if resumed == 0 {
		return errors.New("Runtime process has no resumable thread")
	}
	return nil
}
