package repository

import (
	"errors"
	"os"
)

// FlushFileBuffers requires write access. Git pack files can carry the Windows
// read-only attribute; temporarily clear it ONLY for the recorded owned attempt,
// flush its bytes, then restore it before the workspace becomes admissible.
func syncOwnedFile(path string) (result error) {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return ErrChanged
	}
	if info.Mode().Perm()&0o200 == 0 {
		if err := os.Chmod(path, 0o600); err != nil {
			return err
		}
		defer func() { result = errors.Join(result, os.Chmod(path, info.Mode().Perm())) }()
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}
