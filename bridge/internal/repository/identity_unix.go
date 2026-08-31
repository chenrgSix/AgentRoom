//go:build darwin || linux

package repository

import (
	"fmt"
	"os"
	"syscall"
)

func directoryIdentity(path string) (string, error) {
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
