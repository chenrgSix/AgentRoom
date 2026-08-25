package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectReturnsOpaqueStableSnapshot(t *testing.T) {
	root := t.TempDir()
	gitDirectory := filepath.Join(root, ".git")
	if err := os.Mkdir(gitDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(gitDirectory, "HEAD"),
		[]byte("ref: refs/heads/main\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	first, err := Inspect(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Inspect(root)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("unchanged Workspace snapshot drifted: %#v != %#v", first, second)
	}
	if !strings.HasPrefix(first.WorkspaceRef, "workspace_") ||
		len(first.WorkspaceRef) != len("workspace_")+64 || len(first.Generation) != 64 {
		t.Fatalf("unexpected opaque snapshot: %#v", first)
	}
	if strings.Contains(first.WorkspaceRef, root) || strings.Contains(first.Generation, root) {
		t.Fatal("snapshot exposed its local path")
	}

	if err := os.WriteFile(
		filepath.Join(gitDirectory, "HEAD"),
		[]byte("ref: refs/heads/review\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	changed, err := Inspect(root)
	if err != nil {
		t.Fatal(err)
	}
	if changed.WorkspaceRef != first.WorkspaceRef {
		t.Fatal("repository metadata changed stable Workspace identity")
	}
	if changed.Generation == first.Generation {
		t.Fatal("repository metadata change did not advance observed generation")
	}
}

func TestInspectRejectsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-workspace")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(path); err == nil {
		t.Fatal("file was accepted as a Workspace")
	}
}
