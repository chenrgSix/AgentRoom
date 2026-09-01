//go:build windows

package admission

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	"golang.org/x/sys/windows"
)

func validGovernedProcessObservation(observation bridgeruntime.GovernedProcessObservation) bool {
	if observation.PID <= 0 || !strings.HasPrefix(observation.PlatformIdentity, "windows-filetime:") {
		return false
	}
	value, err := strconv.ParseUint(strings.TrimPrefix(observation.PlatformIdentity, "windows-filetime:"), 10, 64)
	return err == nil && value > 0
}

func lockGovernedProcessFile(file *os.File) error {
	if file == nil {
		return ErrAdmissionInvalid
	}
	return nil
}

func waitGovernedPreparedAbsent(context.Context, string) error {
	// The configured process remains suspended inside a kill-on-close Job until
	// the active record is durable. Once a replacement Bridge owns the data root,
	// a prepared-only child cannot still exist.
	return nil
}

func fenceGovernedProcess(ctx context.Context, observation bridgeruntime.GovernedProcessObservation,
	_ string) error {
	if !validGovernedProcessObservation(observation) {
		return ErrAdmissionInvalid
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE,
		false, uint32(observation.PID))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.ERROR_NOT_FOUND) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return err
	}
	want, _ := strconv.ParseUint(strings.TrimPrefix(observation.PlatformIdentity, "windows-filetime:"), 10, 64)
	got := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	if got != want {
		return nil // The recorded PID was reused; the governed process is absent.
	}
	if err := windows.TerminateProcess(process, 1); err != nil && !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return err
	}
	waitContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := windows.WaitForSingleObject(process, 0)
		if err != nil {
			return err
		}
		if status == windows.WAIT_OBJECT_0 {
			return nil
		}
		select {
		case <-waitContext.Done():
			return waitContext.Err()
		case <-ticker.C:
		}
	}
}
