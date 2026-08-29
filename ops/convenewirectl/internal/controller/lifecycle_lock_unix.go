//go:build darwin || linux

package controller

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const lifecycleLockFilename = "lifecycle.lock"

type lifecycleLockContextKey struct{}

// acquireLifecycleLock gives every mutating controller operation one
// non-blocking process owner for the resolved data root. The context marker
// makes nested operations such as Upgrade -> Backup reentrant without weakening
// exclusion against another process or Controller instance.
func acquireLifecycleLock(
	ctx context.Context,
	dataRoot string,
) (context.Context, func() error, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(dataRoot))
	if err != nil {
		return ctx, nil, actionError(
			"DATA_ROOT_INVALID",
			"data root is invalid",
			"Pass the exact persistent data root used during installation.",
			err,
		)
	}
	if heldRoot, ok := ctx.Value(lifecycleLockContextKey{}).(string); ok {
		if heldRoot != absolute {
			return ctx, nil, actionError(
				"LIFECYCLE_LOCK_SCOPE_INVALID",
				"one lifecycle operation cannot mutate two data roots",
				"Complete the current operation before starting work on another installation.",
				nil,
			)
		}
		return ctx, func() error { return nil }, nil
	}
	if err := ensureBootstrapDirectories(absolute); err != nil {
		return ctx, nil, actionError(
			"LIFECYCLE_LOCK_FAILED",
			"could not prepare the data-root lifecycle lock",
			"Repair the private data-root and control-directory permissions before retrying.",
			err,
		)
	}
	path := filepath.Join(absolute, "control", lifecycleLockFilename)
	file, err := openLifecycleLock(path)
	if err != nil {
		return ctx, nil, actionError(
			"LIFECYCLE_LOCK_FAILED",
			"could not open the data-root lifecycle lock",
			"Restore the owner-only regular lock file or control-directory permissions.",
			err,
		)
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return ctx, nil, actionError(
				"LIFECYCLE_BUSY",
				"another ConveneWire lifecycle operation owns this data root",
				"Wait for the current install, upgrade, restore, trust migration, backup, or uninstall to finish and retry.",
				nil,
			)
		}
		return ctx, nil, actionError(
			"LIFECYCLE_LOCK_FAILED",
			"could not acquire the data-root lifecycle lock",
			"Inspect the data-root filesystem and retry without starting a second operation.",
			err,
		)
	}
	release := func() error {
		unlockErr := syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		closeErr := file.Close()
		return errors.Join(unlockErr, closeErr)
	}
	return context.WithValue(ctx, lifecycleLockContextKey{}, absolute), release, nil
}

func openLifecycleLock(path string) (*os.File, error) {
	info, err := os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("%s must be a private regular file; mode is %s", path, info.Mode())
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !opened.Mode().IsRegular() || opened.Mode().Perm()&0o077 != 0 ||
		(info != nil && !os.SameFile(info, opened)) {
		_ = file.Close()
		return nil, fmt.Errorf("%s changed while opening the lifecycle lock", path)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
