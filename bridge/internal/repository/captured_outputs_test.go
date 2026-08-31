package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type reportTransport struct {
	checkpoint *execution.RepositoryCheckpoint
	sources    map[string]artifact.Source
	calls      int
	failSlot   string
}

func (r *reportTransport) CaptureCheckpoint(context.Context, string) (*execution.RepositoryCheckpoint, error) {
	r.calls++
	return r.checkpoint, nil
}
func (r *reportTransport) PublishCapture(_ context.Context, input artifact.CapturePublishInput) (artifact.PublishResult, error) {
	r.calls++
	if input.SlotKey == r.failSlot {
		return artifact.PublishResult{}, errors.New("fixture response loss")
	}
	source := input.Source
	source.Bytes = bytes.Clone(source.Bytes)
	r.sources[input.SlotKey] = source
	return artifact.PublishResult{ArtifactID: "artifact_" + digest(input.SlotKey), ContentID: "content_" + digest(input.SlotKey), Revision: 1, SHA256: source.SHA256}, nil
}
func (r *reportTransport) SealCaptureCheckpoint(_ context.Context, checkpoint execution.RepositoryCheckpoint) (execution.RepositoryCheckpoint, error) {
	r.calls++
	if !validCheckpoint(checkpoint) {
		return checkpoint, ErrInvalid
	}
	r.checkpoint = &checkpoint
	return checkpoint, nil
}

func reportSeed(t *testing.T, format, document, report string, configureSource ...func(*fixture, *execution.GovernedExecutionManifest)) (*fixture, PreparedWorkspace, CapturedRepository, CapturePublication) {
	t.Helper()
	f := gitFixture(t, format, Limits{})
	if len(document) > artifact.MaximumSourceBytes {
		// An unchanged oversized source document fits the snapshot budget but
		// must not fit the publication budget; keep its bytes out of the patch.
		f.write(t, "tests/review.md", document)
		f.git(t, f.sourcePath, "add", "--all")
		f.git(t, f.sourcePath, "commit", "-m", "large source document")
		f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	}
	m := resumeWireFixture(t)
	m.Repository.BaseCommit, m.Inputs = f.base, []execution.GovernedExecutionManifestInput{}
	m.Workspace.IssuedAt = time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	m.Deadline = time.Now().UTC().Add(20 * time.Minute).Format(time.RFC3339Nano)
	m.Workspace.ExpiresAt, m.Grant.ExpiresAt = m.Deadline, m.Deadline
	m.ScopePolicy.AllowedPaths = []string{"src", "tests"}
	m.ScopePolicy.ForbiddenPaths = []string{}
	m.Outputs = []execution.GovernedExecutionManifestOutput{
		{SlotKey: "patch", Kind: execution.Patch, Required: true},
		{SlotKey: "document", Kind: execution.Document, Required: true},
		{SlotKey: "report", Kind: execution.TestResult, Required: true},
	}
	for _, configure := range configureSource {
		configure(f, &m)
	}
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	m.Repository.BaseCommit = f.base
	resignManifest(t, &m)
	ready := mustPrepare(t, f, Preparation{OperationID: "op_report_prepare0001", RunID: m.Scope.RunID,
		RepositoryID: m.Repository.RepositoryID, BindingID: m.Repository.BindingID, WorkspaceRef: m.Workspace.WorkspaceRef,
		Generation: m.Workspace.WorkspaceGeneration, ManifestDigest: m.ManifestDigest, BaseCommit: f.base,
		Inputs: []PatchInput{}, ScopePolicy: execution.ManifestScopePolicy(m.ScopePolicy)})
	writeWork(t, ready, "src/app.txt", "implemented with reports\n")
	writeWork(t, ready, "tests/review.md", document)
	writeWork(t, ready, "tests/results.json", report)
	op := operationForManifest(t, m, "op_capture_reports0001")
	op.Action = execution.ActionClass{Kind: execution.Capture, Capture: &execution.CaptureClass{ManifestDigest: m.ManifestDigest}}
	op.RequestDigest = resumeDigest(t, op, "requestDigest")
	captured := mustCapture(t, f, CaptureRequest{OperationID: op.OperationID, WorkspaceRef: ready.WorkspaceRef,
		PreparedDigest: ready.IntentDigest, ExpectedGeneration: ready.Generation, ManifestDigest: m.ManifestDigest})
	input := CapturePublication{CaptureDigest: captured.Digest, Manifest: m, Operation: op, Outputs: []CaptureOutputDescription{
		{SlotKey: "patch", Title: "Implementation", Summary: "Captured patch"},
		{SlotKey: "document", Path: "tests/review.md", Title: "Review notes", Summary: "Supplied document"},
		{SlotKey: "report", Path: "tests/results.json", Title: "Test report", Summary: "Supplied report, not verified execution"},
	}}
	return f, ready, captured, input
}

func TestCapturedReportsPublishFrozenObjectsAndRetainResume(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			document, report := "# Review\n原始报告\n", "{\"claimedPassed\":true}\n"
			f, ready, captured, input := reportSeed(t, format, document, report)
			encoded, err := json.Marshal(input.Outputs[0])
			if err != nil || string(encoded) != `{"slotKey":"patch","title":"Implementation","summary":"Captured patch"}` {
				t.Fatal("patch-only publication encoding changed", string(encoded), err)
			}
			writeWork(t, ready, "tests/review.md", "later uncollected document")
			writeWork(t, ready, "tests/results.json", "later invalid JSON")
			transport := &reportTransport{sources: map[string]artifact.Source{}}
			checkpoint, err := f.preparer.PublishCaptured(context.Background(), input, transport)
			if err != nil {
				t.Fatal(err)
			}
			if len(checkpoint.Outputs) != 3 || checkpoint.CandidateTree != captured.CandidateTree ||
				string(transport.sources["document"].Bytes) != document || string(transport.sources["report"].Bytes) != report {
				t.Fatal("wrong sealed content")
			}
			for _, output := range checkpoint.Outputs {
				source := transport.sources[output.SlotKey]
				if output.Artifact.ContentDigest != source.SHA256 || output.Artifact.ByteLength != int64(len(source.Bytes)) {
					t.Fatal("wrong per-slot pin")
				}
				if strings.Contains(source.FileName, "tests") || strings.Contains(source.FileName, "review") {
					t.Fatal("local selector leaked")
				}
			}
			calls := transport.calls
			if err := f.preparer.Close(); err != nil {
				t.Fatal(err)
			}
			f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			replayed, err := f.preparer.PublishCaptured(context.Background(), input, transport)
			if err != nil || !reflect.DeepEqual(replayed, checkpoint) || transport.calls != calls {
				t.Fatal("replay changed or published again", err)
			}
			next, inputs := nextResumeManifest(t, input.Manifest, []PatchInput{}, "reports_resumed01")
			resumed, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, resumeOperation(t, next, checkpoint), checkpoint, inputs)
			if err != nil || resumed.PreparedTree != captured.CandidateTree {
				t.Fatal("report checkpoint cannot resume", err)
			}
			if data, err := os.ReadFile(filepath.Join(resumed.Path, "tests/review.md")); err != nil || string(data) != document {
				t.Fatal("resume imported later report", err)
			}
			if f.git(t, f.sourcePath, "status", "--porcelain=v1") != "" {
				t.Fatal("source mutated")
			}
		})
	}
}

func TestCapturedReportsRejectInvalidSelectionsBeforeTransport(t *testing.T) {
	for _, change := range []string{"traversal", "absolute", "metadata", "wrong extension", "missing", "outside scope", "patch path", "unsupported commit", "missing required", "duplicate slot", "empty document", "invalid UTF8", "invalid JSON", "oversized"} {
		t.Run(change, func(t *testing.T) {
			document, report := "# Review\n", "{\"passed\":true}"
			if change == "empty document" {
				document = ""
			}
			if change == "invalid UTF8" {
				document = string([]byte{0xff, 0xfe})
			}
			if change == "invalid JSON" {
				report = "not JSON"
			}
			if change == "oversized" {
				document = strings.Repeat("a", artifact.MaximumSourceBytes+1)
			}
			f, _, _, input := reportSeed(t, "sha1", document, report)
			switch change {
			case "traversal":
				input.Outputs[1].Path = "../review.md"
			case "absolute":
				input.Outputs[1].Path = "/tmp/review.md"
			case "metadata":
				input.Outputs[1].Path = ".git/review.md"
			case "wrong extension":
				input.Outputs[1].Path = "tests/results.json"
			case "missing":
				input.Outputs[1].Path = "tests/missing.md"
			case "outside scope":
				input.Outputs[1].Path = "secrets/report.md"
			case "patch path":
				input.Outputs[0].Path = "tests/review.md"
			case "unsupported commit":
				input.Manifest.Outputs[1].Kind = execution.Commit
				resignManifest(t, &input.Manifest)
				input.Operation.Action.Capture.ManifestDigest = input.Manifest.ManifestDigest
				input.Operation.RequestDigest = resumeDigest(t, input.Operation, "requestDigest")
			case "missing required":
				input.Outputs = input.Outputs[:2]
			case "duplicate slot":
				input.Outputs[2].SlotKey = "document"
			}
			transport := &reportTransport{sources: map[string]artifact.Source{}}
			if _, err := f.preparer.PublishCaptured(context.Background(), input, transport); err == nil {
				t.Fatal("invalid report accepted")
			}
			if transport.calls != 0 {
				t.Fatal("invalid later slot performed earlier HTTP writes")
			}
			if _, err := os.Stat(f.preparer.claimPath("capture-publication", input.Operation.OperationID)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("invalid output retained publication intent", err)
			}
		})
	}
}

func TestCapturedReportsRejectChangedObjectStore(t *testing.T) {
	for _, change := range []string{"config", "candidate", "object"} {
		t.Run(change, func(t *testing.T) {
			f, _, captured, input := reportSeed(t, "sha1", "# Review\n", "{}")
			gitDir := filepath.Join(f.preparer.capturePath(captured.OperationID), "git")
			switch change {
			case "config":
				f.git(t, gitDir, "config", "core.abbrev", "8")
			case "candidate":
				var candidate captureCandidate
				if err := readJSON(f.preparer.claimPath("capture-candidate", captured.OperationID), &candidate); err != nil {
					t.Fatal(err)
				}
				candidate.Tree = f.base
				raw, err := json.Marshal(candidate)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(f.preparer.claimPath("capture-candidate", captured.OperationID), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			case "object":
				object := f.git(t, gitDir, "rev-parse", captured.CandidateCommit+":tests/review.md")
				objectPath := filepath.Join(gitDir, "objects", object[:2], object[2:])
				if err := os.Chmod(objectPath, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(objectPath, []byte("corrupt"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			transport := &reportTransport{sources: map[string]artifact.Source{}}
			if _, err := f.preparer.PublishCaptured(context.Background(), input, transport); err == nil || transport.calls != 0 {
				t.Fatal("changed capture published", err)
			}
		})
	}
}

func TestCapturedReportPublicationIntentSurvivesPartialUpload(t *testing.T) {
	f, _, _, input := reportSeed(t, "sha1", "# Review\n", "{}", func(f *fixture, _ *execution.GovernedExecutionManifest) {
		f.write(t, "tests/alternate.md", "# Review\n")
		f.git(t, f.sourcePath, "add", "--all")
		f.git(t, f.sourcePath, "commit", "-m", "alternative report with identical content")
	})
	transport := &reportTransport{sources: map[string]artifact.Source{}, failSlot: "report"}
	if _, err := f.preparer.PublishCaptured(context.Background(), input, transport); err == nil {
		t.Fatal("missing injected failure")
	}
	calls := transport.calls
	for _, change := range []string{"title", "path"} {
		changed := input
		changed.Outputs = append([]CaptureOutputDescription{}, input.Outputs...)
		if change == "title" {
			changed.Outputs[1].Title = "changed after partial upload"
		} else {
			changed.Outputs[1].Path = "tests/alternate.md"
		}
		if _, err := f.preparer.PublishCaptured(context.Background(), changed, transport); !errors.Is(err, ErrConflict) || transport.calls != calls {
			t.Fatal("changed publication intent escaped", change, err)
		}
	}
	if err := f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	transport.failSlot = ""
	checkpoint, err := f.preparer.PublishCaptured(context.Background(), input, transport)
	if err != nil || len(checkpoint.Outputs) != 3 {
		t.Fatal("partial publication cannot recover", err)
	}
	preview, err := f.preparer.PreviewCleanup(context.Background(), "op_report_cleanup0001", checkpoint, stoppedCleanupFixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.CleanupWorkspace(context.Background(), CleanupRequest{OperationID: preview.OperationID, Checkpoint: checkpoint, ExpectedPreviewDigest: preview.Digest}, stoppedCleanupFixture); err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.PublishCaptured(context.Background(), input, transport); err != nil {
		t.Fatal("cleaned workspace lost sealed reports", err)
	}
}

func TestCapturedReportsCannotExportSpecialOrOutsideSource(t *testing.T) {
	for _, kind := range []string{"symlink", "directory", "outside scope"} {
		t.Run(kind, func(t *testing.T) {
			if kind == "symlink" && runtime.GOOS == "windows" {
				t.Skip("native symlink privilege gate")
			}
			selected := "tests/selected.md"
			f, _, _, input := reportSeed(t, "sha1", "# Review\n", "{}", func(f *fixture, _ *execution.GovernedExecutionManifest) {
				f.write(t, "tests/source.md", "unrelated source")
				switch kind {
				case "symlink":
					if err := os.Symlink("source.md", filepath.Join(f.sourcePath, selected)); err != nil {
						t.Fatal(err)
					}
				case "directory":
					f.write(t, selected+"/nested.md", "directory is not a report")
				case "outside scope":
					selected = "private/selected.md"
					f.write(t, selected, "not authorized for output")
				}
				f.git(t, f.sourcePath, "add", "--all")
				f.git(t, f.sourcePath, "commit", "-m", "pre-existing source entries")
			})
			input.Outputs[1].Path = selected
			transport := &reportTransport{sources: map[string]artifact.Source{}}
			_, err := f.preparer.PublishCaptured(context.Background(), input, transport)
			expected := map[string]error{"symlink": ErrSpecialOutput, "directory": ErrInvalid, "outside scope": ErrScope}[kind]
			if !errors.Is(err, expected) || transport.calls != 0 {
				t.Fatal("unapproved source exported", err)
			}
		})
	}
}

func TestCapturedReportsWithoutCodeDelta(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		for _, requirePatch := range []bool{false, true} {
			name := format + "/reports_only"
			if requirePatch {
				name = format + "/required_patch"
			}
			t.Run(name, func(t *testing.T) {
				f, ready, captured, input := reportSeed(t, format, "# Review\n", "{}", func(f *fixture, m *execution.GovernedExecutionManifest) {
					f.write(t, "src/app.txt", "implemented with reports\n")
					f.write(t, "tests/review.md", "# Review\n")
					f.write(t, "tests/results.json", "{}")
					f.git(t, f.sourcePath, "add", "--all")
					f.git(t, f.sourcePath, "commit", "-m", "unchanged approved report source")
					if !requirePatch {
						m.Outputs = m.Outputs[1:]
					}
				})
				if captured.PatchBytes != 0 || captured.CandidateTree != ready.PreparedTree {
					t.Fatal("fixture changed code")
				}
				if !requirePatch {
					input.Outputs = input.Outputs[1:]
				}
				transport := &reportTransport{sources: map[string]artifact.Source{}}
				checkpoint, err := f.preparer.PublishCaptured(context.Background(), input, transport)
				if requirePatch {
					if !errors.Is(err, ErrInvalid) || transport.calls != 0 {
						t.Fatal("empty required patch published", err)
					}
					return
				}
				if err != nil || len(checkpoint.Outputs) != 2 {
					t.Fatal("report-only publication rejected", err)
				}
				next, inputs := nextResumeManifest(t, input.Manifest, []PatchInput{}, "empty_report_resume01")
				resumed, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, resumeOperation(t, next, checkpoint), checkpoint, inputs)
				if err != nil || resumed.PreparedTree != captured.CandidateTree {
					t.Fatal("zero-delta checkpoint resume failed", err)
				}
				var intent preparationIntent
				if err := readJSON(f.preparer.claimPath("workspace", resumed.WorkspaceRef), &intent); err != nil {
					t.Fatal(err)
				}
				if !validPreparationVersion(intent) {
					t.Fatal("zero patch pin was invalid")
				}
				intent.Resume.PatchDigest = strings.Repeat("f", 64)
				if validPreparationVersion(intent) {
					t.Fatal("zero patch pin accepted a nonempty digest")
				}
				preview, err := f.preparer.PreviewCleanup(context.Background(), "op_empty_report_cleanup01", checkpoint, stoppedCleanupFixture)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.preparer.CleanupWorkspace(context.Background(), CleanupRequest{OperationID: preview.OperationID, Checkpoint: checkpoint, ExpectedPreviewDigest: preview.Digest}, stoppedCleanupFixture); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
