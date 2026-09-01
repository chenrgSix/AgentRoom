//go:build darwin || linux

package admission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"

	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

const governedProcessFenceTimeout = 5 * time.Second

func validGovernedProcessObservation(observation bridgeruntime.GovernedProcessObservation) bool {
	return observation.PID > 1 &&
		observation.PlatformIdentity == fmt.Sprintf("process-group:%d", observation.PID)
}

func lockGovernedProcessFile(file *os.File) error {
	if file == nil {
		return ErrAdmissionInvalid
	}
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

func waitGovernedPreparedAbsent(ctx context.Context, lockPath string) error {
	return waitGovernedProcessLock(ctx, lockPath, false, 0)
}

func fenceGovernedProcess(ctx context.Context, observation bridgeruntime.GovernedProcessObservation,
	lockPath string) error {
	if !validGovernedProcessObservation(observation) {
		return ErrAdmissionInvalid
	}
	return waitGovernedProcessLock(ctx, lockPath, true, observation.PID)
}

func waitGovernedProcessLock(ctx context.Context, lockPath string, terminate bool, processGroup int) error {
	file, err := openGovernedProcessLock(lockPath)
	if errors.Is(err, os.ErrNotExist) && !terminate {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	available, err := tryGovernedProcessLock(file)
	if err != nil || available {
		return err
	}
	if terminate {
		if err := syscall.Kill(-processGroup, syscall.SIGKILL); err != nil {
			return err
		}
	}
	waitContext, cancel := context.WithTimeout(ctx, governedProcessFenceTimeout)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-waitContext.Done():
			return waitContext.Err()
		case <-ticker.C:
			available, err := tryGovernedProcessLock(file)
			if err != nil {
				return err
			}
			if available {
				return nil
			}
		}
	}
}

func openGovernedProcessLock(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, ErrAdmissionChanged
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		_ = file.Close()
		return nil, ErrAdmissionChanged
	}
	return file, nil
}

func tryGovernedProcessLock(file *os.File) (bool, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		if unlockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_UN); unlockErr != nil {
			return false, unlockErr
		}
		return true, nil
	}
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return false, nil
	}
	return false, err
}
