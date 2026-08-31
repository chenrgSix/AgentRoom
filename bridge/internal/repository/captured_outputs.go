package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type capturedOutput struct {
	slotKey string
	kind    execution.ExternalInputKind
	source  artifact.Source
}

type capturedSource struct {
	Snapshot     workSnapshot
	Ready        PreparedWorkspace
	ObjectFormat string
	GitDirectory string
}

func (p *Preparer) verifiedCapturedSource(ctx context.Context, captured CapturedRepository) (capturedSource, error) {
	var intent captureIntent
	if err := readJSONSized(p.claimPath("operation", captured.OperationID), &intent, 32<<20); err != nil {
		return capturedSource{}, err
	}
	if intent.Kind != "capture" || intent.Version != 1 || intent.Request.OperationID != captured.OperationID ||
		intent.Request.WorkspaceRef != captured.WorkspaceRef || intent.Request.PreparedDigest != captured.PreparedDigest ||
		intent.Request.ManifestDigest != captured.ManifestDigest || intent.Request.ExpectedGeneration != captured.WorkspaceGeneration ||
		intent.ObservedHead != captured.ObservedHead || digest(intent.Snapshot) != captured.SnapshotDigest {
		return capturedSource{}, ErrChanged
	}
	prepared, _, ready, err := p.capturePreparation(intent.Request)
	if err != nil {
		return capturedSource{}, err
	}
	var candidate captureCandidate
	if err := readJSON(p.claimPath("capture-candidate", captured.OperationID), &candidate); err != nil {
		return capturedSource{}, err
	}
	if candidate.Commit != captured.CandidateCommit || candidate.Tree != captured.CandidateTree {
		return capturedSource{}, ErrChanged
	}
	if err := p.verifyCaptureCandidate(ctx, prepared, ready, intent, candidate); err != nil {
		return capturedSource{}, err
	}
	return capturedSource{Snapshot: intent.Snapshot, Ready: ready, ObjectFormat: prepared.Source.ObjectFormat,
		GitDirectory: filepath.Join(p.capturePath(captured.OperationID), "git")}, nil
}

// Report paths remain local selectors into an immutable candidate, never paths
// read from the live workspace or sent as filenames to Central. A test_result
// is supplied report content, not an independently executed verification receipt.
func reportMedia(kind execution.ExternalInputKind, name string) (string, string, error) {
	if !portablePath(name) {
		return "", "", ErrInvalid
	}
	extension := strings.ToLower(path.Ext(name))
	if kind == execution.Document && (extension == ".md" || extension == ".markdown") {
		return ".md", "text/markdown", nil
	}
	if kind == execution.TestResult && extension == ".json" {
		return ".json", "application/json", nil
	}
	return "", "", ErrInvalid
}

func (p *Preparer) captureOutputSources(ctx context.Context, input CapturePublication, captured CapturedRepository, patch []byte) ([]capturedOutput, error) {
	kinds := map[string]execution.ExternalInputKind{}
	for _, slot := range input.Manifest.Outputs {
		kinds[slot.SlotKey] = slot.Kind
	}
	var snapshot workSnapshot
	var gitDir, format string
	var sealed capturedSource
	for _, output := range input.Outputs {
		if kinds[output.SlotKey] == execution.Patch {
			continue
		}
		source, err := p.verifiedCapturedSource(ctx, captured)
		if err != nil {
			return nil, err
		}
		snapshot, format, gitDir = source.Snapshot, source.ObjectFormat, source.GitDirectory
		sealed = source
		break
	}
	outputs := make([]capturedOutput, 0, len(input.Outputs))
	for _, output := range input.Outputs {
		kind := kinds[output.SlotKey]
		if kind == execution.Patch && len(patch) == 0 {
			return nil, ErrInvalid
		}
		source := artifact.Source{Bytes: patch, FileName: "output-" + digest(output.SlotKey) + ".patch", MediaType: "text/x-diff",
			SHA256: captured.PatchDigest, WorkspaceRef: captured.WorkspaceRef, WorkspaceGeneration: captured.WorkspaceGeneration}
		if kind == execution.Commit {
			data, err := p.readCommitBundleLocked(ctx, captured, sealed)
			if err != nil {
				return nil, err
			}
			key := sha256.Sum256(data)
			source.Bytes, source.SHA256 = data, hex.EncodeToString(key[:])
			source.FileName, source.MediaType = "output-"+digest(output.SlotKey)+".bundle", "application/x-git-bundle"
		} else if kind != execution.Patch {
			extension, media, err := reportMedia(kind, output.Path)
			if err != nil {
				return nil, err
			}
			if !allowedOutput(execution.ManifestScopePolicy(input.Manifest.ScopePolicy), output.Path) {
				return nil, ErrScope
			}
			var selected *capturedFile
			for index := range snapshot.Files {
				if snapshot.Files[index].Path == output.Path {
					selected = &snapshot.Files[index]
					break
				}
			}
			if selected == nil {
				return nil, ErrInvalid
			}
			if selected.Mode != "100644" && selected.Mode != "100755" {
				return nil, ErrSpecialOutput
			}
			if selected.Size < 1 || selected.Size > artifact.MaximumSourceBytes {
				return nil, ErrLimit
			}
			data, err := p.git.run(ctx, gitDir, nil, artifact.MaximumSourceBytes, "cat-file", "blob", selected.Object)
			if err != nil {
				return nil, err
			}
			blob := gitBlobHash(format, int64(len(data)))
			blob.Write(data)
			if int64(len(data)) != selected.Size || hex.EncodeToString(blob.Sum(nil)) != selected.Object {
				return nil, ErrChanged
			}
			if !utf8.Valid(data) || (kind == execution.TestResult && !json.Valid(data)) {
				return nil, ErrInvalid
			}
			key := sha256.Sum256(data)
			source.Bytes, source.SHA256 = data, hex.EncodeToString(key[:])
			source.FileName, source.MediaType = "output-"+digest(output.SlotKey)+extension, media
		}
		outputs = append(outputs, capturedOutput{slotKey: output.SlotKey, kind: kind, source: source})
	}
	return outputs, nil
}
