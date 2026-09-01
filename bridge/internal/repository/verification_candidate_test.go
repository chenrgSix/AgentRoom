package repository

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"convenewire.dev/bridge/internal/artifact"
)

func TestMaterializeVerificationCandidateUsesOnlySealedCapture(t *testing.T) {
	f, ready, captured, publication := reportSeed(t, "sha1",
		"# review\n", "{\"passed\":true}\n")
	transport := &reportTransport{sources: map[string]artifact.Source{}}
	checkpoint, err := f.preparer.PublishCaptured(context.Background(), publication, transport)
	if err != nil {
		t.Fatal(err)
	}
	writeWork(t, ready, "src/app.txt", "later owner workspace mutation\n")
	root := filepath.Join(t.TempDir(), "verification-run")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	workspace, err := f.preparer.MaterializeVerificationCandidate(
		context.Background(), checkpoint, root)
	if err != nil {
		t.Fatal(err)
	}
	if workspace != filepath.Join(root, "candidate") ||
		f.git(t, workspace, "rev-parse", "HEAD") != captured.CandidateCommit ||
		f.git(t, workspace, "rev-parse", "HEAD^{tree}") != captured.CandidateTree {
		t.Fatal("verification checkout changed the sealed candidate identity")
	}
	content, err := os.ReadFile(filepath.Join(workspace, "src", "app.txt"))
	if err != nil || string(content) != "implemented with reports\n" {
		t.Fatal("verification checkout read the mutable owner workspace", err)
	}
	if _, err := f.preparer.MaterializeVerificationCandidate(
		context.Background(), checkpoint, root); err == nil {
		t.Fatal("verification candidate identity was reused inside one run root")
	}
}
