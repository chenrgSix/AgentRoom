package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// Snapshot is safe to publish centrally. It deliberately contains no path or
// repository name; Generation is only an opaque comparison token.
type Snapshot struct {
	WorkspaceRef string
	Generation   string
}

// Inspect derives one stable local Workspace identity and an observed
// generation. The initial read-source lease uses the generation for attribution;
// later write coordination must strengthen it with repository-aware CAS rules.
func Inspect(root string) (Snapshot, error) {
	resolved, err := filepath.Abs(filepath.Clean(root))
	if err != nil {
		return Snapshot{}, fmt.Errorf("resolve Workspace: %w", err)
	}
	if canonical, canonicalErr := filepath.EvalSymlinks(resolved); canonicalErr == nil {
		resolved = canonical
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return Snapshot{}, fmt.Errorf("inspect Workspace: %w", err)
	}
	if !info.IsDir() {
		return Snapshot{}, fmt.Errorf("Workspace is not a directory")
	}

	identityDigest := sha256.Sum256([]byte(resolved))
	workspaceRef := "workspace_" + hex.EncodeToString(identityDigest[:])
	generation := sha256.New()
	_, _ = fmt.Fprintf(
		generation,
		"%s\x00%d\x00%d\x00%d",
		workspaceRef,
		info.ModTime().UTC().UnixNano(),
		info.Size(),
		info.Mode(),
	)
	hashLocalMetadata(generation, filepath.Join(resolved, ".git"))
	hashLocalMetadata(generation, filepath.Join(resolved, ".git", "HEAD"))
	hashLocalMetadata(generation, filepath.Join(resolved, ".git", "index"))

	return Snapshot{
		WorkspaceRef: workspaceRef,
		Generation:   hex.EncodeToString(generation.Sum(nil)),
	}, nil
}

type byteWriter interface {
	Write([]byte) (int, error)
}

func hashLocalMetadata(destination byteWriter, path string) {
	info, err := os.Lstat(path)
	if err != nil {
		_, _ = destination.Write([]byte("missing\x00"))
		return
	}
	_, _ = fmt.Fprintf(
		destination,
		"%d\x00%d\x00%d\x00",
		info.ModTime().UTC().UnixNano(),
		info.Size(),
		info.Mode(),
	)
	if !info.Mode().IsRegular() || info.Size() > 4<<10 {
		return
	}
	source, err := os.ReadFile(path)
	if err == nil {
		_, _ = destination.Write(source)
	}
}
