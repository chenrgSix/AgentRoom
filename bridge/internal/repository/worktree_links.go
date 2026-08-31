package repository

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Runtime-writable Git metadata must not redirect the privileged local helper
// outside the owned store through a symlink, FIFO, device or intermediate link.
func checkOwnedGitMetadata(root string, maximum int) error {
	if _, err := directoryIdentity(root); err != nil {
		return err
	}
	count := 0
	return filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return ErrChanged
		}
		count++
		if count > maximum {
			return ErrLimit
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
			return ErrChanged
		}
		return nil
	})
}

// Inspect linking files before asking Git to read workspace-local configuration.
func checkWorktreeLinks(work, gitDir string) error {
	link, err := readRegular(filepath.Join(work, ".git"), 16<<10)
	if err != nil {
		return ErrChanged
	}
	linked := filepath.FromSlash(strings.TrimSuffix(strings.TrimPrefix(string(link), "gitdir: "), "\n"))
	if !strings.HasPrefix(string(link), "gitdir: ") || !contained(filepath.Join(gitDir, "worktrees"), linked) || filepath.Clean(linked) != linked {
		return ErrChanged
	}
	if _, err := directoryIdentity(linked); err != nil {
		return ErrChanged
	}
	back, err := readRegular(filepath.Join(linked, "gitdir"), 16<<10)
	if err != nil || filepath.FromSlash(strings.TrimSuffix(string(back), "\n")) != filepath.Join(work, ".git") {
		return ErrChanged
	}
	common, err := readRegular(filepath.Join(linked, "commondir"), 16<<10)
	if err != nil || filepath.Clean(filepath.Join(linked, strings.TrimSpace(string(common)))) != gitDir {
		return ErrChanged
	}
	if _, err := os.Lstat(filepath.Join(linked, "config.worktree")); !errors.Is(err, os.ErrNotExist) {
		return ErrChanged
	}
	return nil
}
