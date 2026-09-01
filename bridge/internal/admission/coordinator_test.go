package admission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/repository"
	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestGovernedCoordinatorComposesExactPrepareAndPossibleStart(t *testing.T) {
	coordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := coordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(rig.calls, []string{"grant", "inputs", "source", "prepare", "profile", "claim"}) {
		t.Fatalf("prepare order=%v", rig.calls)
	}
	request.RunID = "run_mutated_after_prepare"
	decision, err := coordinator.Start(context.Background(), ticket)
	if err != nil {
		t.Fatal(err)
	}
	if !decision.Invoke || decision.Workspace() != rig.prepared.Path || decision.View.State != RuntimeAdmissionStarting ||
		decision.View.StartDigest == nil || rig.authorityCalls != 1 {
		t.Fatalf("decision=%+v authorityCalls=%d", decision, rig.authorityCalls)
	}
	expected := []string{"grant", "inputs", "source", "prepare", "profile", "claim", "start",
		"grant", "inputs", "source", "prepare", "profile", "authority", "start-write"}
	if !reflect.DeepEqual(rig.calls, expected) {
		t.Fatalf("start order=%v", rig.calls)
	}
	encoded, err := json.Marshal(decision)
	if err != nil || strings.Contains(string(encoded), rig.prepared.Path) || strings.Contains(string(encoded), rig.prepared.GitDirectory) {
		t.Fatalf("durable view leaked local paths: %s err=%v", encoded, err)
	}

	replay, err := coordinator.Start(context.Background(), ticket)
	if err != nil || replay.Invoke || replay.Workspace() != "" || rig.authorityCalls != 1 {
		t.Fatalf("replay=%+v err=%v authorityCalls=%d", replay, err, rig.authorityCalls)
	}
}

func TestGovernedCoordinatorFailsClosedBeforePossibleStart(t *testing.T) {
	t.Run("canceled preparation", func(t *testing.T) {
		coordinator, rig, request := governedCoordinatorFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := coordinator.Prepare(ctx, request); !errors.Is(err, context.Canceled) {
			t.Fatalf("error=%v", err)
		}
		if len(rig.calls) != 0 {
			t.Fatalf("calls=%v", rig.calls)
		}
	})

	t.Run("verification pins do not grant verifier authority", func(t *testing.T) {
		coordinator, rig, request := governedCoordinatorFixture(t)
		if _, err := coordinator.Prepare(context.Background(), request); err != nil {
			t.Fatalf("error=%v", err)
		}
		if !reflect.DeepEqual(rig.calls, []string{"grant", "inputs", "source", "prepare", "profile", "claim"}) {
			t.Fatalf("calls=%v", rig.calls)
		}
	})

	t.Run("canceled start", func(t *testing.T) {
		coordinator, rig, request := governedCoordinatorFixture(t)
		ticket, err := coordinator.Prepare(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		decision, err := coordinator.Start(ctx, ticket)
		if !errors.Is(err, context.Canceled) || decision.Invoke || decision.Workspace() != "" ||
			rig.authorityCalls != 0 || rig.started {
			t.Fatalf("decision=%+v error=%v authorityCalls=%d started=%t", decision, err, rig.authorityCalls, rig.started)
		}
	})

	t.Run("grant denied", func(t *testing.T) {
		coordinator, rig, request := governedCoordinatorFixture(t)
		rig.grantErr = repository.ErrGrantDenied
		if _, err := coordinator.Prepare(context.Background(), request); !errors.Is(err, repository.ErrGrantDenied) {
			t.Fatalf("error=%v", err)
		}
		if !reflect.DeepEqual(rig.calls, []string{"grant"}) {
			t.Fatalf("calls=%v", rig.calls)
		}
	})

	for _, test := range []struct {
		name   string
		change func(*coordinatorRig)
		want   error
	}{
		{"prepared identity drift", func(rig *coordinatorRig) { rig.changePreparedAt = 2 }, ErrAdmissionChanged},
		{"profile drift", func(rig *coordinatorRig) { rig.changeProfileAt = 2 }, ErrAdmissionChanged},
		{"Server rejection", func(rig *coordinatorRig) { rig.authorityErr = ErrAdmissionNotCurrent }, ErrAdmissionNotCurrent},
		{"changed Server view", func(rig *coordinatorRig) { rig.changeAuthority = true }, ErrAdmissionChanged},
	} {
		t.Run(test.name, func(t *testing.T) {
			coordinator, rig, request := governedCoordinatorFixture(t)
			ticket, err := coordinator.Prepare(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			test.change(rig)
			decision, err := coordinator.Start(context.Background(), ticket)
			if !errors.Is(err, test.want) || decision.Invoke || decision.Workspace() != "" || rig.started {
				t.Fatalf("decision=%+v error=%v started=%t", decision, err, rig.started)
			}
		})
	}
}

func TestGovernedCoordinatorReportsPersistedPossibleStartAfterWriteResponseFailure(t *testing.T) {
	coordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := coordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	rig.startWriteErr = errors.New("read after durable start failed")
	decision, err := coordinator.Start(context.Background(), ticket)
	if !errors.Is(err, ErrAdmissionPossibleStart) || decision.Invoke ||
		decision.View.State != RuntimeAdmissionStarting || decision.View.StartDigest == nil || !rig.started {
		t.Fatalf("decision=%+v error=%v started=%t", decision, err, rig.started)
	}
}

func TestGovernedCoordinatorFreezesAgentConfiguration(t *testing.T) {
	_, rig, request := governedCoordinatorFixture(t)
	manifest, err := DecodeGovernedManifest(request)
	if err != nil {
		t.Fatal(err)
	}
	agent := config.AgentConfig{Name: "Builder", Adapter: "codex", RuntimeKind: "codex",
		PresetVersion: config.CurrentPresetVersion, Command: []string{"codex", "app-server"},
		EnvAllowlist: []string{"PATH"}, Sandbox: "workspace-write"}
	agents := map[string]config.AgentConfig{manifest.Scope.AgentID: agent}
	coordinator, err := newGovernedAdmissionCoordinator(rig, rig, rig, rig, rig, rig, agents)
	if err != nil {
		t.Fatal(err)
	}
	agent.Command[0] = "mutated"
	agent.EnvAllowlist[0] = "MUTATED"
	delete(agents, manifest.Scope.AgentID)
	frozen := coordinator.agents[manifest.Scope.AgentID]
	if !reflect.DeepEqual(frozen.Command, []string{"codex", "app-server"}) ||
		!reflect.DeepEqual(frozen.EnvAllowlist, []string{"PATH"}) {
		t.Fatalf("agent configuration was not frozen: %+v", frozen)
	}
	if _, err := newGovernedAdmissionCoordinator(rig, rig, rig, rig, rig, rig,
		map[string]config.AgentConfig{"foreign": frozen}); !errors.Is(err, ErrAdmissionInvalid) {
		t.Fatalf("invalid agent ID error=%v", err)
	}
}

func TestExactManifestPatchesBindsOrderKindLengthAndDigest(t *testing.T) {
	manifest := runtimeManifestFixture(t)
	content := []byte("diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n")
	hash := sha256.Sum256(content)
	binding := &manifest.Inputs[0]
	binding.Artifact.Kind = execution.Patch
	binding.Artifact.ByteLength = int64(len(content))
	binding.Artifact.ContentDigest = hex.EncodeToString(hash[:])
	valid := repository.PatchInput{BindingID: binding.BindingID, SHA256: binding.Artifact.ContentDigest, Bytes: content}
	frozen, err := exactManifestPatches(manifest, []repository.PatchInput{valid})
	if err != nil {
		t.Fatal(err)
	}
	content[0] = 'X'
	if frozen[0].Bytes[0] == 'X' {
		t.Fatal("returned input retained caller-owned bytes")
	}
	for name, change := range map[string]func(*repository.PatchInput, *execution.GovernedExecutionManifestInput){
		"missing": func(input *repository.PatchInput, _ *execution.GovernedExecutionManifestInput) { input.Bytes = nil },
		"binding": func(input *repository.PatchInput, _ *execution.GovernedExecutionManifestInput) {
			input.BindingID = "input_foreign0001"
		},
		"digest": func(input *repository.PatchInput, _ *execution.GovernedExecutionManifestInput) {
			input.SHA256 = strings.Repeat("f", 64)
		},
		"length": func(_ *repository.PatchInput, binding *execution.GovernedExecutionManifestInput) {
			binding.Artifact.ByteLength++
		},
		"kind": func(_ *repository.PatchInput, binding *execution.GovernedExecutionManifestInput) {
			binding.Artifact.Kind = execution.Commit
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidateManifest := manifest
			candidateManifest.Inputs = append([]execution.GovernedExecutionManifestInput{}, manifest.Inputs...)
			candidate := valid
			candidate.Bytes = append([]byte{}, valid.Bytes...)
			change(&candidate, &candidateManifest.Inputs[0])
			if _, err := exactManifestPatches(candidateManifest, []repository.PatchInput{candidate}); !errors.Is(err, ErrAdmissionInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
	if _, err := exactManifestPatches(manifest, nil); !errors.Is(err, ErrAdmissionInvalid) {
		t.Fatalf("missing list error=%v", err)
	}
}

type coordinatorRig struct {
	calls            []string
	manifest         execution.GovernedExecutionManifest
	source           repository.Source
	prepared         repository.PreparedWorkspace
	profile          RuntimeProfileView
	claim            RuntimeAdmissionView
	start            RuntimeAdmissionView
	grantErr         error
	authorityErr     error
	changePreparedAt int
	changeProfileAt  int
	changeAuthority  bool
	prepareCalls     int
	profileCalls     int
	authorityCalls   int
	started          bool
	stopCalls        int
	stopped          RuntimeAdmissionView
	startWriteErr    error
}

func (r *coordinatorRig) CheckTaskGrant(_ context.Context, manifest execution.GovernedExecutionManifest,
	operation execution.KindElement, _ time.Time) error {
	r.calls = append(r.calls, "grant")
	if operation != execution.Prepare || !reflect.DeepEqual(manifest, r.manifest) {
		return ErrAdmissionChanged
	}
	return r.grantErr
}

func (r *coordinatorRig) LoadPatches(_ context.Context, manifest execution.GovernedExecutionManifest) ([]repository.PatchInput, error) {
	r.calls = append(r.calls, "inputs")
	if !reflect.DeepEqual(manifest, r.manifest) {
		return nil, ErrAdmissionChanged
	}
	return []repository.PatchInput{}, nil
}

func (r *coordinatorRig) ResolveSource(_ context.Context, binding, repositoryID string, revision int) (repository.Source, error) {
	r.calls = append(r.calls, "source")
	if binding != r.manifest.Repository.BindingID || repositoryID != r.manifest.Repository.RepositoryID || revision != 1 {
		return repository.Source{}, ErrAdmissionChanged
	}
	return r.source, nil
}

func (r *coordinatorRig) Prepare(_ context.Context, _ repository.Source, input repository.Preparation) (repository.PreparedWorkspace, error) {
	r.calls = append(r.calls, "prepare")
	r.prepareCalls++
	if input.OperationID != "op_prepare_"+r.manifest.ManifestDigest || input.RunID != r.manifest.Scope.RunID ||
		input.ManifestDigest != r.manifest.ManifestDigest || len(input.Inputs) != 0 {
		return repository.PreparedWorkspace{}, ErrAdmissionChanged
	}
	prepared := r.prepared
	if r.changePreparedAt == r.prepareCalls {
		prepared.PreparedTree = strings.Repeat("d", len(prepared.PreparedTree))
	}
	return prepared, nil
}

func (r *coordinatorRig) ProbeCodexRuntime(_ context.Context, input CodexRuntimeProbe, _ time.Time) (RuntimeProfileView, error) {
	r.calls = append(r.calls, "profile")
	r.profileCalls++
	if input.AgentID != r.manifest.Scope.AgentID || input.Workspace != r.prepared.Path ||
		input.Reference.ProfileID != r.manifest.Repository.RuntimeProfileID || input.Reference.Digest != r.manifest.Repository.RuntimeProfileDigest {
		return RuntimeProfileView{}, ErrAdmissionChanged
	}
	profile := r.profile
	if r.changeProfileAt == r.profileCalls {
		profile.ExecutableDigest = strings.Repeat("1", 64)
	}
	return profile, nil
}

func (r *coordinatorRig) Claim(spec RuntimeAdmissionSpec, _ time.Time) (RuntimeAdmissionView, error) {
	r.calls = append(r.calls, "claim")
	r.claim = RuntimeAdmissionView{Spec: spec, AdmissionDigest: strings.Repeat("9", 64),
		State: RuntimeAdmissionClaimed, ClaimedAt: profileTime(runtimeFenceNow)}
	return r.claim, nil
}

func (r *coordinatorRig) Start(ctx context.Context, run, digest string, authorize RuntimeStartAuthority) (RuntimeAdmissionView, bool, error) {
	r.calls = append(r.calls, "start")
	if r.started {
		return r.start, false, nil
	}
	if run != r.claim.Spec.RunID || digest != r.claim.AdmissionDigest {
		return RuntimeAdmissionView{}, false, ErrAdmissionChanged
	}
	if err := authorize(ctx, r.claim.Spec); err != nil {
		return RuntimeAdmissionView{}, false, err
	}
	r.calls = append(r.calls, "start-write")
	r.started = true
	startDigest, checked := strings.Repeat("8", 64), profileTime(runtimeFenceNow)
	r.start = r.claim
	r.start.State, r.start.StartDigest, r.start.AuthorityCheckedAt = RuntimeAdmissionStarting, &startDigest, &checked
	if r.startWriteErr != nil {
		return RuntimeAdmissionView{}, false, r.startWriteErr
	}
	return r.start, true, nil
}

func (r *coordinatorRig) Get(_ string) (RuntimeAdmissionView, error) {
	if r.stopped.State != "" {
		return r.stopped, nil
	}
	if r.start.State != "" {
		return r.start, nil
	}
	return r.claim, nil
}

func (r *coordinatorRig) Stop(run, admissionDigest, startDigest string, outcome RuntimeOutcome,
	_ time.Time) (RuntimeAdmissionView, error) {
	r.stopCalls++
	if run != r.start.Spec.RunID || admissionDigest != r.start.AdmissionDigest || r.start.StartDigest == nil ||
		startDigest != *r.start.StartDigest || !validRuntimeOutcome(outcome) {
		return RuntimeAdmissionView{}, ErrAdmissionChanged
	}
	if r.stopped.State != "" {
		if r.stopped.Outcome == nil || *r.stopped.Outcome != outcome {
			return RuntimeAdmissionView{}, ErrAdmissionConflict
		}
		return r.stopped, nil
	}
	stoppedAt := profileTime(runtimeFenceNow.Add(time.Minute))
	r.stopped = r.start
	r.stopped.State, r.stopped.Outcome, r.stopped.StoppedAt = RuntimeAdmissionStopped, &outcome, &stoppedAt
	return r.stopped, nil
}

func (r *coordinatorRig) Check(_ context.Context, spec RuntimeAdmissionSpec) (RuntimeAuthorityView, error) {
	r.calls = append(r.calls, "authority")
	r.authorityCalls++
	if r.authorityErr != nil {
		return RuntimeAuthorityView{}, r.authorityErr
	}
	view := RuntimeAuthorityView{Version: 1, RunID: spec.RunID, LeaseID: spec.LeaseID,
		ManifestDigest: spec.ManifestDigest, WorkspaceRef: spec.WorkspaceRef, WorkspaceGeneration: spec.WorkspaceGeneration,
		State: execution.Active, LeaseRevision: 1, CheckedAt: profileTime(runtimeFenceNow), ExpiresAt: spec.WorkspaceExpiresAt}
	if r.changeAuthority {
		view.RunID = "run_foreign0001"
	}
	return view, nil
}

func governedCoordinatorFixture(t *testing.T) (*GovernedAdmissionCoordinator, *coordinatorRig, contracts.RunRequestedPayload) {
	t.Helper()
	request := governedDeliveryFixture(t)
	manifest, err := DecodeGovernedManifest(request)
	if err != nil {
		t.Fatal(err)
	}
	manifest.Inputs = []execution.GovernedExecutionManifestInput{}
	manifest.InputDigest, err = executionDigest(manifest.Inputs, "")
	if err != nil {
		t.Fatal(err)
	}
	manifest.ManifestDigest, err = executionDigest(manifest, "manifestDigest")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(manifest)
	if err != nil || json.Unmarshal(raw, request.ContextManifest.Execution) != nil {
		t.Fatal("replace governed fixture manifest")
	}
	if _, err := DecodeGovernedManifest(request); err != nil {
		t.Fatal(err)
	}
	prepared, profile := runtimePrerequisites(manifest)
	prepared.OperationID = "op_prepare_" + manifest.ManifestDigest
	rig := &coordinatorRig{manifest: manifest,
		source: repository.Source{Root: "/source", GitDirectory: "/source/.git", CommonDirectory: "/source/.git",
			ObjectFormat: "sha1", RootIdentity: "root", GitIdentity: "git", CommonIdentity: "git"},
		prepared: prepared, profile: profile}
	agent := config.AgentConfig{Name: "Builder", Adapter: "codex", RuntimeKind: "codex", PresetVersion: config.CurrentPresetVersion,
		Command: []string{"codex", "app-server", "--listen", "stdio://"}, Sandbox: "workspace-write"}
	coordinator, err := newGovernedAdmissionCoordinator(rig, rig, rig, rig, rig, rig,
		map[string]config.AgentConfig{manifest.Scope.AgentID: agent})
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = func() time.Time { return runtimeFenceNow }
	return coordinator, rig, request
}
