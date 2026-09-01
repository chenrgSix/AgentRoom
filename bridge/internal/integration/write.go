package integration

import (
	"errors"
	"os"
	"path/filepath"

	"convenewire.dev/bridge/internal/durablefs"
)

func writeExclusive(path string, raw []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".pending-integration-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(raw); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(name, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return os.ErrExist
		}
		return err
	}
	return durablefs.SyncParent(path)
}
