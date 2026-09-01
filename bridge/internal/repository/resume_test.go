package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
)

// Local resume tests use real Git and the actual publication journal. Only the
// already-tested Central transport is substituted here; these receipts are
// fixture identities, not evidence of a Server, Runtime or verifier invocation.
type resumeTransport struct {
	checkpoints map[string]execution.RepositoryCheckpoint
	patches     map[string][]byte
}

func (transport *resumeTransport) CaptureCheckpoint(_ context.Context, operationID string) (*execution.RepositoryCheckpoint, error) {
	checkpoint, exists := transport.checkpoints[operationID]
	if !exists {
		return nil, nil
	}
	return &checkpoint, nil
}

func (transport *resumeTransport) PublishCapture(_ context.Context, input artifact.CapturePublishInput) (artifact.PublishResult, error) {
	if err := artifact.ValidateCaptureContext(input.Manifest, input.Operation); err != nil {
		return artifact.PublishResult{}, err
	}
	transport.patches[input.Operation.OperationID] = bytes.Clone(input.Source.Bytes)
	return artifact.PublishResult{ArtifactID: "artifact_" + digest(input.Operation.OperationID)[:32], ContentID: "content_resume0001",
		Revision: 7, SHA256: input.Source.SHA256}, nil
}

func (transport *resumeTransport) SealCaptureCheckpoint(_ context.Context, checkpoint execution.RepositoryCheckpoint) (execution.RepositoryCheckpoint, error) {
	if !validCheckpoint(checkpoint) {
		return checkpoint, ErrInvalid
	}
	transport.checkpoints[checkpoint.OperationID] = checkpoint
	return checkpoint, nil
}

func resumeWireFixture(t *testing.T) execution.GovernedExecutionManifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Cases []struct {
			Name     string
			Instance json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	for _, entry := range suite.Cases {
		if entry.Name == "execution runtime: valid manifest" {
			var manifest execution.GovernedExecutionManifest
			if err := json.Unmarshal(entry.Instance, &manifest); err != nil {
				t.Fatal(err)
			}
			return manifest
		}
	}
	t.Fatal("manifest fixture missing")
	return execution.GovernedExecutionManifest{}
}

func resumeDigest(t *testing.T, value any, field string) string {
	t.Helper()
	key, err := executionValueDigest(value, field)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func resignManifest(t *testing.T, manifest *execution.GovernedExecutionManifest) {
	t.Helper()
	manifest.InputDigest = resumeDigest(t, manifest.Inputs, "")
	manifest.ManifestDigest = resumeDigest(t, manifest, "manifestDigest")
}

func operationForManifest(t *testing.T, manifest execution.GovernedExecutionManifest, operationID string) execution.RepositoryOperationRequest {
	t.Helper()
	scope := execution.RepositoryOperationRequestExecution(manifest.Scope)
	return execution.RepositoryOperationRequest{Version: 1, OperationID: operationID,
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID, Revision: scope.PlanRevision, Digest: scope.PlanDigest,
			ApprovalOperationID: scope.ApprovalOperationID, RoomID: scope.RoomID, RootTaskID: "task_resume_root0001"},
		Execution: &scope, RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID, DeviceID: scope.DeviceID,
		Grant: execution.RepositoryOperationRequestGrant(manifest.Grant), ExpectedGeneration: manifest.Workspace.WorkspaceGeneration, Deadline: manifest.Deadline}
}

func resumeOperation(t *testing.T, manifest execution.GovernedExecutionManifest, checkpoint execution.RepositoryCheckpoint) execution.RepositoryOperationRequest {
	t.Helper()
	op := operationForManifest(t, manifest, "op_prepare_"+manifest.Scope.RunID)
	var nested execution.Manifest
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &nested); err != nil {
		t.Fatal(err)
	}
	op.Action = execution.ActionClass{Kind: execution.Prepare, Prepare: &execution.PrepareClass{Manifest: nested, ResumeCheckpointID: &checkpoint.CheckpointID}}
	op.RequestDigest = resumeDigest(t, op, "requestDigest")
	return op
}

func publishResumeFixture(t *testing.T, f *fixture, ready PreparedWorkspace, manifest execution.GovernedExecutionManifest, transport *resumeTransport) (CapturedRepository, execution.RepositoryCheckpoint) {
	t.Helper()
	op := operationForManifest(t, manifest, "op_capture_"+manifest.Scope.RunID)
	op.Action = execution.ActionClass{Kind: execution.Capture, Capture: &execution.ActionCapture{ManifestDigest: manifest.ManifestDigest}}
	op.RequestDigest = resumeDigest(t, op, "requestDigest")
	captured := mustCapture(t, f, CaptureRequest{OperationID: op.OperationID, WorkspaceRef: ready.WorkspaceRef,
		PreparedDigest: ready.IntentDigest, ExpectedGeneration: ready.Generation, ManifestDigest: manifest.ManifestDigest})
	checkpoint, err := f.preparer.PublishCaptured(context.Background(), CapturePublication{CaptureDigest: captured.Digest, Manifest: manifest,
		Operation: op, Outputs: []CaptureOutputDescription{{SlotKey: manifest.Outputs[0].SlotKey, Title: "Resume fixture", Summary: "Real Git; fixture transport"}}}, transport)
	if err != nil {
		t.Fatal(err)
	}
	return captured, checkpoint
}

type resumeSeed struct {
	f          *fixture
	manifest   execution.GovernedExecutionManifest
	ready      PreparedWorkspace
	captured   CapturedRepository
	checkpoint execution.RepositoryCheckpoint
	inputs     []PatchInput
	transport  *resumeTransport
}

func seedResume(t *testing.T, format string, upstream bool) resumeSeed {
	t.Helper()
	f := gitFixture(t, format, Limits{})
	manifest := resumeWireFixture(t)
	manifest.Repository.BaseCommit = f.base
	manifest.Workspace.IssuedAt = time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	manifest.Deadline = time.Now().UTC().Add(20 * time.Minute).Format(time.RFC3339Nano)
	manifest.Grant.ExpiresAt, manifest.Workspace.ExpiresAt = manifest.Deadline, manifest.Deadline
	inputs := []PatchInput{}
	if upstream {
		input := patch("base", "approved upstream", "resume_upstream01")
		manifest.Inputs[0].BindingID = input.BindingID
		manifest.Inputs[0].Artifact.ContentDigest, manifest.Inputs[0].Artifact.ByteLength = input.SHA256, int64(len(input.Bytes))
		manifest.Inputs[0].IssuedAt, manifest.Inputs[0].ExpiresAt = manifest.Workspace.IssuedAt, manifest.Deadline
		manifest.Inputs[0].SourceCommit, manifest.Inputs[0].SourceTree = nil, nil
		manifest.ScopePolicy.AllowedPaths = []string{"tests"}
		inputs = append(inputs, input)
	} else {
		manifest.Inputs = []execution.GovernedExecutionManifestInput{}
	}
	resignManifest(t, &manifest)
	ready := mustPrepare(t, f, Preparation{OperationID: "op_prepare_resume_seed", RunID: manifest.Scope.RunID, RepositoryID: manifest.Repository.RepositoryID,
		BindingID: manifest.Repository.BindingID, WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
		ManifestDigest: manifest.ManifestDigest, BaseCommit: f.base, Inputs: inputs, ScopePolicy: execution.ManifestScopePolicy(manifest.ScopePolicy)})
	writeWork(t, ready, "tests/first.txt", "first implementation\n")
	transport := &resumeTransport{checkpoints: map[string]execution.RepositoryCheckpoint{}, patches: map[string][]byte{}}
	captured, checkpoint := publishResumeFixture(t, f, ready, manifest, transport)
	return resumeSeed{f: f, manifest: manifest, ready: ready, captured: captured, checkpoint: checkpoint, inputs: inputs, transport: transport}
}

func nextResumeManifest(t *testing.T, previous execution.GovernedExecutionManifest, inputs []PatchInput, suffix string) (execution.GovernedExecutionManifest, []PatchInput) {
	t.Helper()
	raw, err := json.Marshal(previous)
	if err != nil {
		t.Fatal(err)
	}
	var next execution.GovernedExecutionManifest
	if err := json.Unmarshal(raw, &next); err != nil {
		t.Fatal(err)
	}
	next.Scope.RunID = "run_resume_" + suffix
	next.Scope.DispatchGeneration++
	next.Scope.TaskRevision++
	next.Scope.PlanControlRevision++
	next.Workspace.WorkspaceRef, next.Workspace.LeaseID = "workspace_"+digest(suffix), "lease_resume_"+suffix
	next.Workspace.WorkspaceGeneration = digest(suffix + "generation")
	next.Workspace.IssuedAt = time.Now().UTC().Format(time.RFC3339Nano)
	newInputs := append([]PatchInput{}, inputs...)
	for index := range next.Inputs {
		next.Inputs[index].BindingID = "input_resume_" + suffix + "_" + strconv.Itoa(index)
		next.Inputs[index].DestinationRunID = next.Scope.RunID
		next.Inputs[index].IssuedAt = next.Workspace.IssuedAt
		newInputs[index].BindingID = next.Inputs[index].BindingID
	}
	resignManifest(t, &next)
	return next, newInputs
}

func TestResumeCheckpointPreservesCumulativeOutputAcrossTwoAttempts(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		for _, upstream := range []bool{false, true} {
			name := format + "_empty_inputs"
			if upstream {
				name = format + "_upstream_inputs"
			}
			t.Run(name, func(t *testing.T) {
				seed := seedResume(t, format, upstream)
				f := seed.f
				// The uncollected old writer directory must not become resume input.
				writeWork(t, seed.ready, "tests/first.txt", "uncollected later edit\n")
				writeWork(t, seed.ready, "private-later.txt", "do not collect or delete\n")
				oldHead, oldStatus := f.git(t, seed.ready.Path, "rev-parse", "HEAD"), f.git(t, seed.ready.Path, "status", "--porcelain=v1")
				oldIndex, err := os.ReadFile(filepath.Join(seed.ready.GitDirectory, "worktrees", "work", "index"))
				if err != nil {
					t.Fatal(err)
				}
				if err := f.preparer.Close(); err != nil {
					t.Fatal(err)
				}
				f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
				if err != nil {
					t.Fatal(err)
				}
				next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "second0001")
				operation := resumeOperation(t, next, seed.checkpoint)
				ready, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, operation, seed.checkpoint, inputs)
				if err != nil {
					t.Fatal(err)
				}
				if ready.Path == seed.ready.Path || ready.GitDirectory == seed.ready.GitDirectory || ready.PreparedTree != seed.checkpoint.CandidateTree || ready.OutputBaseCommit == "" {
					t.Fatal("resume did not create an independent exact tree", ready)
				}
				if f.git(t, ready.GitDirectory, "rev-parse", ready.OutputBaseCommit+"^{tree}") != seed.ready.PreparedTree {
					t.Fatal("output baseline included checkpoint changes")
				}
				if f.git(t, ready.Path, "status", "--porcelain=v1") != "" || f.git(t, ready.Path, "show", "HEAD:tests/first.txt") != "first implementation" {
					t.Fatal("resumed wrong working bytes")
				}
				replayed, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, operation, seed.checkpoint, inputs)
				if err != nil || !reflect.DeepEqual(ready, replayed) {
					t.Fatal("replay", err)
				}
				writeWork(t, ready, "tests/second.txt", "second implementation\n")
				if _, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, operation, seed.checkpoint, inputs); !errors.Is(err, ErrChanged) {
					t.Fatal("dirty resume was reset or accepted", err)
				}
				captured, checkpoint := publishResumeFixture(t, f, ready, next, seed.transport)
				patchBytes := seed.transport.patches[captured.OperationID]
				if len(captured.Changes) != 2 || !bytes.Contains(patchBytes, []byte("+first implementation")) || !bytes.Contains(patchBytes, []byte("+second implementation")) ||
					bytes.Contains(patchBytes, []byte("private-later")) || bytes.Contains(patchBytes, []byte("src/app.txt")) || captured.OutputBaseCommit != ready.OutputBaseCommit {
					t.Fatal("patch lost old work, re-exported upstream or leaked uncollected edits", string(patchBytes))
				}
				if upstream && checkpoint.InputDigest == seed.checkpoint.InputDigest {
					t.Fatal("new input grants were not frozen")
				}
				// Independently apply the cumulative output after the approved upstream
				// inputs. Comparing actual Git trees catches an incremental-only patch.
				applied := request(f.base, "apply_cumulative_output")
				applied.Inputs = append(append([]PatchInput{}, seed.inputs...), PatchInput{BindingID: "input_cumulative_output", SHA256: captured.PatchDigest, Bytes: patchBytes})
				if mustPrepare(t, f, applied).PreparedTree != captured.CandidateTree {
					t.Fatal("cumulative patch does not reproduce candidate")
				}
				third, thirdInputs := nextResumeManifest(t, next, inputs, "third0001")
				thirdReady, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, resumeOperation(t, third, checkpoint), checkpoint, thirdInputs)
				if err != nil {
					t.Fatal(err)
				}
				thirdCapture, _ := publishResumeFixture(t, f, thirdReady, third, seed.transport)
				if thirdCapture.CandidateTree != captured.CandidateTree || !bytes.Equal(seed.transport.patches[thirdCapture.OperationID], patchBytes) {
					t.Fatal("unchanged second resume lost cumulative output")
				}
				afterIndex, err := os.ReadFile(filepath.Join(seed.ready.GitDirectory, "worktrees", "work", "index"))
				if err != nil || !bytes.Equal(oldIndex, afterIndex) || oldHead != f.git(t, seed.ready.Path, "rev-parse", "HEAD") || oldStatus != f.git(t, seed.ready.Path, "status", "--porcelain=v1") {
					t.Fatal("old worktree changed", err)
				}
				if f.git(t, f.sourcePath, "rev-parse", "HEAD") != f.base || f.git(t, f.sourcePath, "status", "--porcelain=v1") != "" {
					t.Fatal("source checkout changed")
				}
			})
		}
	}
}

func TestResumeRejectsChangedApprovedContextBeforeCreatingAttempt(t *testing.T) {
	seed := seedResume(t, "sha1", true)
	for name, change := range map[string]func(*execution.GovernedExecutionManifest){
		"same run": func(v *execution.GovernedExecutionManifest) {
			v.Scope.RunID = seed.manifest.Scope.RunID
			v.Inputs[0].DestinationRunID = v.Scope.RunID
		},
		"old generation": func(v *execution.GovernedExecutionManifest) {
			v.Scope.DispatchGeneration = seed.manifest.Scope.DispatchGeneration
		},
		"old task revision": func(v *execution.GovernedExecutionManifest) {
			v.Scope.TaskRevision = seed.manifest.Scope.TaskRevision - 1
		},
		"old control revision": func(v *execution.GovernedExecutionManifest) {
			v.Scope.PlanControlRevision = seed.manifest.Scope.PlanControlRevision - 1
		},
		"same workspace": func(v *execution.GovernedExecutionManifest) {
			v.Workspace.WorkspaceRef = seed.manifest.Workspace.WorkspaceRef
		},
		"same lease": func(v *execution.GovernedExecutionManifest) { v.Workspace.LeaseID = seed.manifest.Workspace.LeaseID },
		"same workspace generation": func(v *execution.GovernedExecutionManifest) {
			v.Workspace.WorkspaceGeneration = seed.manifest.Workspace.WorkspaceGeneration
		},
		"another task":      func(v *execution.GovernedExecutionManifest) { v.Scope.TaskID = "task_foreign0001" },
		"another agent":     func(v *execution.GovernedExecutionManifest) { v.Scope.AgentID = "agent_foreign0001" },
		"another device":    func(v *execution.GovernedExecutionManifest) { v.Scope.DeviceID = "device_foreign0001" },
		"another plan":      func(v *execution.GovernedExecutionManifest) { v.Scope.PlanID = "plan_foreign0001" },
		"new plan revision": func(v *execution.GovernedExecutionManifest) { v.Scope.PlanRevision++ },
		"criteria":          func(v *execution.GovernedExecutionManifest) { v.Scope.CriteriaRevision++ },
		"definition":        func(v *execution.GovernedExecutionManifest) { v.Scope.DefinitionRevision++ },
		"repository":        func(v *execution.GovernedExecutionManifest) { v.Repository.RepositoryID = "repo_foreign0001" },
		"binding":           func(v *execution.GovernedExecutionManifest) { v.Repository.BindingID = "repobind_foreign0001" },
		"base":              func(v *execution.GovernedExecutionManifest) { v.Repository.BaseCommit = strings.Repeat("b", 40) },
		"runtime": func(v *execution.GovernedExecutionManifest) {
			v.Repository.RuntimeProfileDigest = strings.Repeat("e", 64)
		},
		"scope": func(v *execution.GovernedExecutionManifest) { v.ScopePolicy.AllowedPaths = []string{"."} },
		"verification": func(v *execution.GovernedExecutionManifest) {
			v.VerificationProfiles[0].Digest = strings.Repeat("e", 64)
		},
		"output":       func(v *execution.GovernedExecutionManifest) { v.Outputs[0].SlotKey = "changed" },
		"input source": func(v *execution.GovernedExecutionManifest) { v.Inputs[0].SourceTaskID = "task_foreign0001" },
		"reused input grant": func(v *execution.GovernedExecutionManifest) {
			v.Inputs[0].BindingID = seed.manifest.Inputs[0].BindingID
		},
		"input receipt":           func(v *execution.GovernedExecutionManifest) { v.Inputs[0].GateDigest = strings.Repeat("e", 64) },
		"input artifact revision": func(v *execution.GovernedExecutionManifest) { v.Inputs[0].Artifact.ArtifactRevision++ },
		"input destination":       func(v *execution.GovernedExecutionManifest) { v.Inputs[0].DestinationRunID = seed.manifest.Scope.RunID },
		"input slot":              func(v *execution.GovernedExecutionManifest) { v.Inputs[0].InputSlot = "other" },
		"removed input":           func(v *execution.GovernedExecutionManifest) { v.Inputs = []execution.GovernedExecutionManifestInput{} },
		"input expiry":            func(v *execution.GovernedExecutionManifest) { v.Inputs[0].ExpiresAt = v.Inputs[0].IssuedAt },
		"before checkpoint":       func(v *execution.GovernedExecutionManifest) { v.Workspace.IssuedAt = seed.manifest.Workspace.IssuedAt },
	} {
		t.Run(name, func(t *testing.T) {
			next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "negative0001")
			change(&next)
			if name == "reused input grant" {
				// Keep supplied bytes consistent so only the immutable-grant fence
				// rejects this; a later byte-binding mismatch must not hide the gap.
				inputs[0].BindingID = next.Inputs[0].BindingID
			}
			resignManifest(t, &next)
			before, err := os.ReadDir(filepath.Join(seed.f.state, "attempts"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), seed.f.source, resumeOperation(t, next, seed.checkpoint), seed.checkpoint, inputs); err == nil {
				t.Fatal("accepted changed context")
			}
			after, err := os.ReadDir(filepath.Join(seed.f.state, "attempts"))
			if err != nil || len(after) != len(before) {
				t.Fatal("invalid resume created an attempt", err)
			}
		})
	}
}

func TestResumeRejectsWireAndReceiptSubstitution(t *testing.T) {
	seed := seedResume(t, "sha1", false)
	for name, change := range map[string]func(*execution.RepositoryOperationRequest, *execution.RepositoryCheckpoint){
		"operation digest": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.RequestDigest = strings.Repeat("e", 64)
		},
		"manifest digest": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.Action.Prepare.Manifest.ManifestDigest = strings.Repeat("e", 64)
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"input digest": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.Action.Prepare.Manifest.InputDigest = strings.Repeat("e", 64)
			op.Action.Prepare.Manifest.ManifestDigest = resumeDigest(t, op.Action.Prepare.Manifest, "manifestDigest")
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"no selection": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.Action.Prepare.ResumeCheckpointID = nil
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"wrong selection": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			*op.Action.Prepare.ResumeCheckpointID = "checkpoint_wrong0001"
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"scope mismatch": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.Execution.TaskRevision++
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"grant mismatch": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.Grant.Revision++
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"generation mismatch": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.ExpectedGeneration = strings.Repeat("e", 64)
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"root mismatch": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			op.Plan.RootTaskID = "task_foreignroot0001"
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"late deadline": func(op *execution.RepositoryOperationRequest, _ *execution.RepositoryCheckpoint) {
			limit, _ := time.Parse(time.RFC3339Nano, op.Deadline)
			op.Deadline = limit.Add(time.Minute).Format(time.RFC3339Nano)
			op.RequestDigest = resumeDigest(t, op, "requestDigest")
		},
		"checkpoint digest": func(_ *execution.RepositoryOperationRequest, checkpoint *execution.RepositoryCheckpoint) {
			checkpoint.Digest = strings.Repeat("e", 64)
		},
		"checkpoint tree": func(_ *execution.RepositoryOperationRequest, checkpoint *execution.RepositoryCheckpoint) {
			checkpoint.CandidateTree = strings.Repeat("e", 40)
			checkpoint.Digest = resumeDigest(t, checkpoint, "digest")
		},
		"checkpoint artifact": func(_ *execution.RepositoryOperationRequest, checkpoint *execution.RepositoryCheckpoint) {
			checkpoint.Outputs[0].Artifact.ArtifactRevision++
			checkpoint.Digest = resumeDigest(t, checkpoint, "digest")
		},
	} {
		t.Run(name, func(t *testing.T) {
			next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "wire0001")
			// Detach the checkpoint output slice as well as the operation manifest.
			raw, _ := json.Marshal(seed.checkpoint)
			var checkpoint execution.RepositoryCheckpoint
			if err := json.Unmarshal(raw, &checkpoint); err != nil {
				t.Fatal(err)
			}
			op := resumeOperation(t, next, checkpoint)
			change(&op, &checkpoint)
			if _, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), seed.f.source, op, checkpoint, inputs); err == nil {
				t.Fatal("accepted substituted context")
			}
			if _, err := os.Stat(seed.f.preparer.attemptPath(next.Workspace.WorkspaceRef)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("created unapproved attempt", err)
			}
		})
	}
}

func TestResumeRequiresRetainedConfirmedBytes(t *testing.T) {
	for _, change := range []string{"unconfirmed", "corrupt patch", "foreign source", "wrong input bytes", "wrong input binding"} {
		t.Run(change, func(t *testing.T) {
			seed := seedResume(t, "sha1", true)
			next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "retained0001")
			source := seed.f.source
			switch change {
			case "unconfirmed":
				if err := os.Remove(seed.f.preparer.claimPath("checkpoint", seed.checkpoint.OperationID)); err != nil {
					t.Fatal(err)
				}
			case "corrupt patch":
				if err := os.WriteFile(filepath.Join(seed.f.preparer.capturePath(seed.checkpoint.OperationID), "output.patch"), []byte("corrupted"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "foreign source":
				other := gitFixture(t, "sha1", Limits{})
				source = other.source
			case "wrong input bytes":
				inputs[0].Bytes = []byte("substituted")
			case "wrong input binding":
				inputs[0].BindingID = "input_foreign0001"
			}
			if _, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), source, resumeOperation(t, next, seed.checkpoint), seed.checkpoint, inputs); err == nil {
				t.Fatal("accepted unavailable source")
			}
			if _, err := os.Stat(seed.f.preparer.attemptPath(next.Workspace.WorkspaceRef)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("invalid input created attempt", err)
			}
			if _, err := os.Stat(seed.ready.Path); err != nil {
				t.Fatal("old work lost", err)
			}
		})
	}
}

func TestResumeRetainsExactIntentThroughLostReceiptAndRestart(t *testing.T) {
	seed := seedResume(t, "sha1", true)
	next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "replay0001")
	// Renewed local grant identity is permitted, not inferred to be authorized.
	// The production caller must still prove this grant before invoking resume.
	next.Grant.GrantID, next.Grant.Revision = "grant_renewed0001", next.Grant.Revision+1
	next.Repository.GrantID, next.Repository.GrantRevision = next.Grant.GrantID, next.Grant.Revision
	resignManifest(t, &next)
	op := resumeOperation(t, next, seed.checkpoint)
	ready, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), seed.f.source, op, seed.checkpoint, inputs)
	if err != nil {
		t.Fatal(err)
	}
	var intent preparationIntent
	if err := readJSON(seed.f.preparer.claimPath("workspace", ready.WorkspaceRef), &intent); err != nil {
		t.Fatal(err)
	}
	if intent.Version != 3 || intent.Resume == nil || intent.Resume.CheckpointID != seed.checkpoint.CheckpointID || intent.Resume.RequestDigest != op.RequestDigest {
		t.Fatal("resume identity was not frozen")
	}
	changed := op
	deadline, _ := time.Parse(time.RFC3339Nano, changed.Deadline)
	changed.Deadline = deadline.Add(-time.Second).Format(time.RFC3339Nano)
	changed.RequestDigest = resumeDigest(t, changed, "requestDigest")
	if _, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), seed.f.source, changed, seed.checkpoint, inputs); !errors.Is(err, ErrConflict) {
		t.Fatal("same operation accepted different deadline", err)
	}
	path := seed.f.preparer.claimPath("ready", ready.WorkspaceRef)
	if err := os.Rename(path, path+".lost-fixture"); err != nil {
		t.Fatal(err)
	}
	if err := seed.f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	seed.f.preparer, err = NewPreparer(seed.f.state, seed.f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	again, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), seed.f.source, op, seed.checkpoint, inputs)
	if err != nil || !reflect.DeepEqual(ready, again) {
		t.Fatal("resume receipt changed after restart", err)
	}
	writeWork(t, ready, "src/app.txt", "out-of-scope upstream rewrite\n")
	request := CaptureRequest{OperationID: "op_resumed_scope0001", WorkspaceRef: ready.WorkspaceRef,
		PreparedDigest: ready.IntentDigest, ExpectedGeneration: ready.Generation, ManifestDigest: next.ManifestDigest}
	if _, err := seed.f.preparer.Capture(context.Background(), request); !errors.Is(err, ErrScope) {
		t.Fatal("resumed scope gate was bypassed", err)
	}
}

func TestResumeValidatesAppliedTreeAndRecoversSealedCandidate(t *testing.T) {
	for _, wrongTree := range []bool{false, true} {
		name := "sealed before checkout"
		if wrongTree {
			name = "mismatched candidate tree"
		}
		t.Run(name, func(t *testing.T) {
			seed := seedResume(t, "sha1", true)
			next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "candidate0001")
			op := resumeOperation(t, next, seed.checkpoint)
			request := Preparation{OperationID: op.OperationID, RunID: next.Scope.RunID, RepositoryID: next.Repository.RepositoryID,
				BindingID: next.Repository.BindingID, WorkspaceRef: next.Workspace.WorkspaceRef, Generation: next.Workspace.WorkspaceGeneration,
				ManifestDigest: next.ManifestDigest, BaseCommit: next.Repository.BaseCommit, Inputs: inputs, ScopePolicy: execution.ManifestScopePolicy(next.ScopePolicy)}
			intent, err := seed.f.preparer.intent(seed.f.source, request)
			if err != nil {
				t.Fatal(err)
			}
			patch, err := seed.f.preparer.ReadCapturedPatch(context.Background(), seed.captured.OperationID, seed.captured.Digest)
			if err != nil {
				t.Fatal(err)
			}
			resume := &checkpointResume{pin: checkpointResumePin{RequestDigest: op.RequestDigest, CheckpointID: seed.checkpoint.CheckpointID,
				CheckpointDigest: seed.checkpoint.Digest, CaptureOperationID: seed.captured.OperationID, CaptureDigest: seed.captured.Digest,
				SourceRunID: seed.captured.RunID, SourceWorkspaceRef: seed.captured.WorkspaceRef, CandidateTree: seed.captured.CandidateTree,
				PatchDigest: seed.captured.PatchDigest, PatchBytes: seed.captured.PatchBytes}, patch: patch}
			if wrongTree {
				resume.pin.CandidateTree = strings.Repeat("f", 40)
			}
			intent.Version, intent.Resume = 3, &resume.pin
			// Crash cut is seeded at the private Git stage, not via a public
			// permission bypass. Public resume revalidates all receipts afterward.
			candidate, err := seed.f.preparer.createCandidate(context.Background(), intent, inputs, resume)
			if wrongTree {
				if !errors.Is(err, ErrChanged) {
					t.Fatal("accepted mismatched applied tree", err)
				}
				if _, err := os.Stat(seed.f.preparer.claimPath("candidate", request.WorkspaceRef)); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("sealed mismatched candidate", err)
				}
				if _, err := os.Stat(seed.f.preparer.attemptPath(request.WorkspaceRef)); err != nil {
					t.Fatal("incomplete attempt not retained", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := seed.f.preparer.Close(); err != nil {
				t.Fatal(err)
			}
			seed.f.preparer, err = NewPreparer(seed.f.state, seed.f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			ready, err := seed.f.preparer.PrepareFromCheckpoint(context.Background(), seed.f.source, op, seed.checkpoint, inputs)
			if err != nil || ready.PreparedTree != candidate.Tree || ready.OutputBaseCommit != candidate.OutputBaseCommit {
				t.Fatal("sealed candidate not recovered", err)
			}
		})
	}
}

func TestResumePatchExpansionSharesInputBudget(t *testing.T) {
	upstream := patch("base", "upstream", "budget0001")
	resume := &checkpointResume{patch: []byte("retained checkpoint patch")}
	limit := int64(len(upstream.Bytes) + len(resume.patch))
	if err := resume.checkInputs([]PatchInput{upstream}, limit); err != nil {
		t.Fatal(err)
	}
	if err := resume.checkInputs([]PatchInput{upstream}, limit-1); !errors.Is(err, ErrLimit) {
		t.Fatal("resume escaped aggregate input budget", err)
	}
}

func TestOrdinaryPreparationRetainsVersionTwoEncoding(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "versiontwo0001"))
	captured := mustCapture(t, f, captureRequest(ready, "versiontwo0001"))
	var intent preparationIntent
	if err := readJSON(f.preparer.claimPath("workspace", ready.WorkspaceRef), &intent); err != nil {
		t.Fatal(err)
	}
	if intent.Version != 2 || intent.Resume != nil || ready.OutputBaseCommit != "" || captured.OutputBaseCommit != "" {
		t.Fatal("ordinary journal was migrated")
	}
	for _, value := range []any{intent, ready, captured} {
		raw, err := json.Marshal(value)
		if err != nil || bytes.Contains(raw, []byte(`"resume":`)) || bytes.Contains(raw, []byte(`"outputBaseCommit":`)) {
			t.Fatal("changed ordinary journal encoding", err)
		}
	}
}

func TestResumeInputOrderingAndGrantIdentity(t *testing.T) {
	previous := resumeWireFixture(t)
	previous.Workspace.IssuedAt = time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	previous.Deadline = time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano)
	previous.Grant.ExpiresAt, previous.Workspace.ExpiresAt = previous.Deadline, previous.Deadline
	previous.Inputs[0].IssuedAt, previous.Inputs[0].ExpiresAt = previous.Workspace.IssuedAt, previous.Deadline
	second := previous.Inputs[0]
	second.BindingID, second.InputSlot, second.SourceTaskID = "input_second0001", "second", "task_second0001"
	previous.Inputs = append(previous.Inputs, second)
	resignManifest(t, &previous)
	next, _ := nextResumeManifest(t, previous, []PatchInput{{}, {}}, "ordered0001")
	if !compatibleResume(previous, next) {
		t.Fatal("unchanged sources with fresh grants rejected")
	}
	next.Inputs[0], next.Inputs[1] = next.Inputs[1], next.Inputs[0]
	if compatibleResume(previous, next) {
		t.Fatal("changed source order accepted")
	}
	next.Inputs[0], next.Inputs[1] = next.Inputs[1], next.Inputs[0]
	next.Inputs[0].BindingID = previous.Inputs[1].BindingID
	if compatibleResume(previous, next) {
		t.Fatal("another old input grant retargeted")
	}
}
