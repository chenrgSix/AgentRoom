package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
)

// Driven only by the real Server HTTP integration test. This test executable is
// not a production CLI, grant provider, Runtime or substitute admission path.
func TestCapturePublicationHTTPProcess(t *testing.T) {
	if os.Getenv("CONVENE_WIRE_CAPTURE_HTTP_PROCESS") != "1" {
		t.Skip("Server-driven process fixture")
	}
	var input struct {
		ServerURL, Token, SourcePath, StatePath, CaptureDigest, Title string
		ExpectError                                                   bool
		Manifest                                                      execution.GovernedExecutionManifest
		Operation                                                     execution.RepositoryOperationRequest
		ResumeOperation                                               *execution.RepositoryOperationRequest
		ResumeCheckpoint                                              *execution.RepositoryCheckpoint
	}
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 2<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	git, err = filepath.Abs(git)
	if err != nil {
		t.Fatal(err)
	}
	p, err := NewPreparer(input.StatePath, git, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Close(); err != nil {
			t.Error(err)
		}
	})
	var captured CapturedRepository
	var workPath string
	var preparedTree string
	if input.CaptureDigest == "" {
		source, err := InspectSource(ctx, git, input.SourcePath, []string{filepath.Dir(input.SourcePath)}, Limits{})
		if err != nil {
			t.Fatal(err)
		}
		manifest := input.Manifest
		var ready PreparedWorkspace
		if input.ResumeOperation != nil {
			if input.ResumeCheckpoint == nil {
				t.Fatal("missing selected checkpoint")
			}
			ready, err = p.PrepareFromCheckpoint(ctx, source, *input.ResumeOperation, *input.ResumeCheckpoint, []PatchInput{})
		} else {
			ready, err = p.Prepare(ctx, source, Preparation{OperationID: "op_http_prepare0001", RunID: manifest.Scope.RunID,
				RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
				WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
				ManifestDigest: manifest.ManifestDigest, BaseCommit: manifest.Repository.BaseCommit, Inputs: []PatchInput{},
				ScopePolicy: execution.ManifestScopePolicy(manifest.ScopePolicy)})
		}
		if err != nil {
			t.Fatal(err)
		}
		workPath = ready.Path
		preparedTree = ready.PreparedTree
		// Explicit fixture output, not an Agent invocation or claimed verifier run.
		name, content := "app.txt", "implemented through real capture\n"
		if input.ResumeOperation != nil {
			name, content = "continued.txt", "continued after explicit checkpoint resume\n"
		}
		if err := os.WriteFile(filepath.Join(ready.Path, "src", name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		captured, err = p.Capture(ctx, CaptureRequest{OperationID: input.Operation.OperationID,
			WorkspaceRef: ready.WorkspaceRef, PreparedDigest: ready.IntentDigest,
			ExpectedGeneration: ready.Generation, ManifestDigest: manifest.ManifestDigest})
		if err != nil {
			t.Fatal(err)
		}
		input.CaptureDigest = captured.Digest
	} else {
		if err := readJSONSized(p.claimPath("capture", input.Operation.OperationID), &captured, 32<<20); err != nil {
			t.Fatal(err)
		}
		workPath = filepath.Join(p.attemptPath(captured.WorkspaceRef), "work")
	}
	slot := ""
	for _, output := range input.Manifest.Outputs {
		if output.Kind == execution.Patch {
			slot = output.SlotKey
			break
		}
	}
	title := "Captured implementation"
	if input.Title != "" {
		title = input.Title
	}
	client := artifact.NewClient(config.Config{ServerURL: input.ServerURL}, pairing.Credential{Token: input.Token})
	checkpoint, err := p.PublishCaptured(ctx, CapturePublication{CaptureDigest: input.CaptureDigest,
		Manifest: input.Manifest, Operation: input.Operation,
		Outputs: []CaptureOutputDescription{{SlotKey: slot, Title: title, Summary: "Actual Git bytes; not independent verification"}}}, client)
	if (err != nil) != input.ExpectError {
		t.Fatalf("publication error: %v (expected=%v)", err, input.ExpectError)
	}
	result := struct {
		CaptureDigest, WorkPath, PreparedTree, CandidateCommit, CandidateTree, Error string
		Checkpoint                                                                   execution.RepositoryCheckpoint
	}{CaptureDigest: input.CaptureDigest, WorkPath: workPath, PreparedTree: preparedTree, CandidateCommit: captured.CandidateCommit,
		CandidateTree: captured.CandidateTree, Checkpoint: checkpoint}
	if err != nil {
		result.Error = err.Error()
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("CAPTURE_RESULT " + string(encoded))
}
