//go:build darwin || linux

package repository

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func directoryIdentity(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != filepath.Clean(path) {
		return "", ErrChanged
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return "", ErrChanged
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", ErrChanged
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
