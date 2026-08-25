package artifact

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testWorkspace(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(root, ".git", "HEAD"),
		[]byte("ref: refs/heads/main\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestCaptureReturnsStablePathFreeSnapshot(t *testing.T) {
	root := testWorkspace(t)
	if err := os.Mkdir(filepath.Join(root, "results"), 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "results", "change.patch")
	sourceBytes := []byte("diff --git a/a.go b/a.go\n+verified\n")
	if err := os.WriteFile(path, sourceBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := Capture(root, "results/change.patch", "patch")
	if err != nil {
		t.Fatal(err)
	}
	if string(source.Bytes) != string(sourceBytes) || source.FileName != "change.patch" ||
		source.MediaType != "text/x-diff" || len(source.SHA256) != 64 {
		t.Fatalf("unexpected capture: %#v", source)
	}
	if strings.Contains(source.WorkspaceRef, root) ||
		strings.Contains(source.WorkspaceGeneration, root) {
		t.Fatal("capture exposed the local Workspace path")
	}
}

func TestCaptureRejectsTraversalSymlinksAndTypeMismatch(t *testing.T) {
	root := testWorkspace(t)
	outside := filepath.Join(t.TempDir(), "outside.patch")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "linked.patch")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "folder.patch"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, testCase := range []struct {
		path, artifactType, errorPart string
	}{
		{"../outside.patch", "patch", "stay inside"},
		{outside, "patch", "Workspace-relative"},
		{"linked.patch", "patch", "symbolic links"},
		{"folder.patch", "patch", "regular file"},
		{".git", "document", "extension"},
	} {
		_, err := Capture(root, testCase.path, testCase.artifactType)
		if err == nil || !strings.Contains(err.Error(), testCase.errorPart) {
			t.Fatalf("Capture(%q) error = %v, want %q", testCase.path, err, testCase.errorPart)
		}
	}
}

func TestCaptureRejectsAFileChangedDuringRead(t *testing.T) {
	root := testWorkspace(t)
	target := filepath.Join(root, "result.json")
	if err := os.WriteFile(target, []byte(`{"ok":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := capture(root, "result.json", "test_result", func(path string) error {
		return os.WriteFile(path, []byte(`{"ok":fail}`), 0o600)
	})
	if err == nil || !strings.Contains(err.Error(), "changed during capture") {
		t.Fatalf("changed file error = %v", err)
	}
}
