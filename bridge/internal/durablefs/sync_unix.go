//go:build darwin || linux

package durablefs

import (
	"fmt"
	"os"
)

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open durable state directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync durable state directory: %w", err)
	}
	return nil
}
