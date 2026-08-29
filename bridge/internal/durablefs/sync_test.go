package durablefs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSyncParentAfterAtomicInstall(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "state.json")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SyncParent(path); err != nil {
		t.Fatal(err)
	}
}
