package ownership

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const lockFilename = ".bridge-owner.lock"

// Lock is an advisory, process-scoped lease for the mutable state below one
// Bridge data directory. The lock file is intentionally retained between runs;
// the operating system releases the lease if the owning process exits.
type Lock struct {
	file      *os.File
	directory string
	once      sync.Once
	err       error
}

type contextKey struct{}

func Acquire(dataDir string) (*Lock, error) {
	resolved, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("resolve Bridge data directory: %w", err)
	}
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return nil, fmt.Errorf("create Bridge data directory: %w", err)
	}
	directory, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return nil, fmt.Errorf("resolve Bridge data directory links: %w", err)
	}
	path := filepath.Join(directory, lockFilename)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open Bridge owner lock: %w", err)
	}
	info, infoErr := file.Stat()
	pathInfo, pathErr := os.Lstat(path)
	if infoErr != nil || pathErr != nil || pathInfo.Mode()&os.ModeSymlink != 0 ||
		!info.Mode().IsRegular() || !os.SameFile(info, pathInfo) {
		_ = file.Close()
		return nil, fmt.Errorf("Bridge owner lock must be one regular file")
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("protect Bridge owner lock: %w", err)
	}
	if err := lockFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("Bridge data directory is already owned by another process: %w", err)
	}
	return &Lock{file: file, directory: directory}, nil
}

// WithOwner marks a context as already covered by an owner held by the shell.
// Bridge core uses this only to avoid reacquiring its own Desktop/Console lock;
// a different data directory still requires an independent OS lease.
func WithOwner(ctx context.Context, owner *Lock) context.Context {
	if owner == nil {
		return ctx
	}
	return context.WithValue(ctx, contextKey{}, owner)
}

// AcquireForContext either borrows the exact owner carried by ctx or acquires a
// new process lock. The returned release is always safe to defer.
func AcquireForContext(ctx context.Context, dataDir string) (func() error, error) {
	if owner, ok := ctx.Value(contextKey{}).(*Lock); ok && owner.owns(dataDir) {
		return func() error { return nil }, nil
	}
	owner, err := Acquire(dataDir)
	if err != nil {
		return nil, err
	}
	return owner.Release, nil
}

func (l *Lock) owns(dataDir string) bool {
	if l == nil || l.file == nil {
		return false
	}
	resolved, err := filepath.Abs(dataDir)
	if err != nil {
		return false
	}
	directory, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return false
	}
	ownedInfo, ownedErr := os.Stat(l.directory)
	candidateInfo, candidateErr := os.Stat(directory)
	return ownedErr == nil && candidateErr == nil && os.SameFile(ownedInfo, candidateInfo)
}

func (l *Lock) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	l.once.Do(func() {
		unlockErr := unlockFile(l.file)
		closeErr := l.file.Close()
		if unlockErr != nil {
			l.err = fmt.Errorf("unlock Bridge data directory: %w", unlockErr)
		} else if closeErr != nil {
			l.err = fmt.Errorf("close Bridge owner lock: %w", closeErr)
		}
	})
	return l.err
}
