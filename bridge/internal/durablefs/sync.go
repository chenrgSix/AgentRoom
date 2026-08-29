// Package durablefs contains the final metadata barrier for Bridge state that
// has already been fsynced and atomically installed.
package durablefs

import (
	"path/filepath"
)

func SyncParent(path string) error {
	return SyncDirectory(filepath.Dir(path))
}

func SyncDirectory(path string) error {
	return syncDirectory(path)
}
