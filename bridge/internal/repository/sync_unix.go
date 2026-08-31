//go:build darwin || linux

package repository

import (
	"errors"
	"os"
)

func syncOwnedFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(file.Sync(), file.Close())
}
