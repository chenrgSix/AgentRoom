package admission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
)

var runtimeFenceNow = time.Date(2026, 8, 31, 10, 5, 0, 0, time.UTC)

func TestRuntimeAdmissionSpecBindsExactPreparedWorkspaceAndProfile(t *testing.T) {
	manifest := runtimeManifestFixture(t)
	prepared, profile := runtimePrerequisites(manifest)
	spec, err := NewRuntimeAdmissionSpec(manifest, prepared, profile)
	if err != nil {
		t.Fatal(err)
	}
	if spec.RunID != manifest.Scope.RunID || spec.ManifestDigest != manifest.ManifestDigest || spec.WorkspaceRef != prepared.WorkspaceRef ||
		spec.RuntimeProfileDigest != profile.Digest || spec.PreparedIdentityDigest != digest([]byte(prepared.WorkIdentity)) {
		t.Fatalf("admission spec did not retain exact prerequisite pins: %+v", spec)
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, local := range []string{prepared.Path, prepared.GitDirectory, prepared.Branch, prepared.WorkIdentity, "/owner-secret"} {
		if strings.Contains(string(raw), local) {
			t.Fatalf("path-free spec exposed %q: %s", local, raw)
		}
	}

	for name, change := range map[string]func(*execution.GovernedExecutionManifest, *repository.PreparedWorkspace, *RuntimeProfileView){
		"manifest digest": func(manifest *execution.GovernedExecutionManifest, _ *repository.PreparedWorkspace, _ *RuntimeProfileView) {
			manifest.ManifestDigest = strings.Repeat("f", 64)
		},
		"input digest": func(manifest *execution.GovernedExecutionManifest, _ *repository.PreparedWorkspace, _ *RuntimeProfileView) {
			manifest.InputDigest = strings.Repeat("f", 64)
		},
		"workspace": func(_ *execution.GovernedExecutionManifest, prepared *repository.PreparedWorkspace, _ *RuntimeProfileView) {
			prepared.WorkspaceRef = "workspace_changed0001"
		},
		"generation": func(_ *execution.GovernedExecutionManifest, prepared *repository.PreparedWorkspace, _ *RuntimeProfileView) {
			prepared.Generation = strings.Repeat("f", 64)
		},
		"base": func(_ *execution.GovernedExecutionManifest, prepared *repository.PreparedWorkspace, _ *RuntimeProfileView) {
			prepared.BaseCommit = strings.Repeat("f", 40)
		},
		"physical identity": func(_ *execution.GovernedExecutionManifest, prepared *repository.PreparedWorkspace, _ *RuntimeProfileView) {
			prepared.WorkIdentity = ""
		},
		"profile digest": func(_ *execution.GovernedExecutionManifest, _ *repository.PreparedWorkspace, profile *RuntimeProfileView) {
			profile.Digest = strings.Repeat("f", 64)
		},
		"profile revocation": func(_ *execution.GovernedExecutionManifest, _ *repository.PreparedWorkspace, profile *RuntimeProfileView) {
			revoked := profileTime(runtimeFenceNow)
			profile.RevokedAt = &revoked
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidateManifest := manifest
			candidatePrepared, candidateProfile := prepared, profile
			change(&candidateManifest, &candidatePrepared, &candidateProfile)
			if _, err := NewRuntimeAdmissionSpec(candidateManifest, candidatePrepared, candidateProfile); !errors.Is(err, ErrAdmissionInvalid) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestRuntimeAdmissionClaimIsImmutableExclusiveAndPathFree(t *testing.T) {
	store, spec := runtimeFenceFixture(t)
	first, err := store.Claim(spec, runtimeFenceNow)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != RuntimeAdmissionClaimed || len(first.AdmissionDigest) != 64 || first.StartDigest != nil || first.Outcome != nil {
		t.Fatalf("claim=%+v", first)
	}
	replay, err := store.Claim(spec, runtimeFenceNow.Add(time.Minute))
	if err != nil || !reflect.DeepEqual(replay, first) {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	replay, err = store.Claim(spec, time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC))
	if err != nil || !reflect.DeepEqual(replay, first) {
		t.Fatalf("expired exact replay=%+v err=%v", replay, err)
	}
	persisted, err := os.ReadFile(store.path(spec.RunID, RuntimeAdmissionClaimed))
	if err != nil {
		t.Fatal(err)
	}
	for _, local := range []string{"/owner-secret/worktree", "/owner-secret/git", "identity:/owner-secret", "refs/convenewire/secret"} {
		if strings.Contains(string(persisted), local) {
			t.Fatalf("claim exposed local value %q: %s", local, persisted)
		}
	}

	changed := spec
	changed.PreparedTree = strings.Repeat("d", 40)
	if _, err := store.Claim(changed, runtimeFenceNow); !errors.Is(err, ErrAdmissionConflict) {
		t.Fatalf("changed same-Run error=%v", err)
	}
	collision := spec
	collision.RunID = "run_runtimecollision01"
	if _, err := store.Claim(collision, runtimeFenceNow); !errors.Is(err, ErrAdmissionConflict) {
		t.Fatalf("workspace reuse error=%v", err)
	}
	expired := spec
	expired.RunID = "run_runtimeexpired001"
	expired.WorkspaceRef = "workspace_runtimeexpired001"
	expired.WorkspaceGeneration = strings.Repeat("e", 64)
	expired.PreparedOperationID = "op_runtimeexpired001"
	expired.PreparedIdentityDigest = strings.Repeat("e", 64)
	if _, err := store.Claim(expired, time.Date(2026, 8, 31, 11, 0, 0, 0, time.UTC)); !errors.Is(err, ErrAdmissionNotCurrent) {
		t.Fatalf("expired error=%v", err)
	}
}

func TestRuntimeAdmissionStartWritesPossibleStartOnceAfterAuthority(t *testing.T) {
	store, spec := runtimeFenceFixture(t)
	claim, err := store.Claim(spec, runtimeFenceNow)
	if err != nil {
		t.Fatal(err)
	}
	denied := errors.New("current Run canceled")
	if _, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest, func(context.Context, RuntimeAdmissionSpec) error {
		return denied
	}, func() time.Time { return runtimeFenceNow }); !errors.Is(err, denied) || invoke {
		t.Fatalf("denied start invoke=%v err=%v", invoke, err)
	}
	if _, err := os.Lstat(store.path(spec.RunID, RuntimeAdmissionStarting)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("denied authority persisted start-intent: %v", err)
	}
	calledForWrongDigest := false
	if _, invoke, err := store.start(context.Background(), spec.RunID, strings.Repeat("f", 64), func(context.Context, RuntimeAdmissionSpec) error {
		calledForWrongDigest = true
		return nil
	}, func() time.Time { return runtimeFenceNow }); !errors.Is(err, ErrAdmissionConflict) || invoke || calledForWrongDigest {
		t.Fatalf("wrong digest invoke=%v callback=%v err=%v", invoke, calledForWrongDigest, err)
	}

	var callbacks atomic.Int64
	var invoked atomic.Int64
	start := make(chan struct{})
	var wait sync.WaitGroup
	for range 12 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			view, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest, func(_ context.Context, candidate RuntimeAdmissionSpec) error {
				callbacks.Add(1)
				if candidate != spec {
					t.Errorf("authority received changed spec: %+v", candidate)
				}
				return nil
			}, func() time.Time { return runtimeFenceNow.Add(time.Minute) })
			if err != nil || view.State != RuntimeAdmissionStarting {
				t.Errorf("start view=%+v err=%v", view, err)
			}
			if invoke {
				invoked.Add(1)
			}
		}()
	}
	close(start)
	wait.Wait()
	if invoked.Load() != 1 || callbacks.Load() < 1 {
		t.Fatalf("invoke=%d callbacks=%d", invoked.Load(), callbacks.Load())
	}

	started, err := store.Get(spec.RunID)
	if err != nil || started.State != RuntimeAdmissionStarting || started.StartDigest == nil || started.AuthorityCheckedAt == nil {
		t.Fatalf("started=%+v err=%v", started, err)
	}
	called := false
	if replay, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest, func(context.Context, RuntimeAdmissionSpec) error {
		called = true
		return nil
	}, func() time.Time { return runtimeFenceNow.Add(2 * time.Minute) }); err != nil || invoke || called || !reflect.DeepEqual(replay, started) {
		t.Fatalf("start replay=%+v invoke=%v callback=%v err=%v", replay, invoke, called, err)
	}
}

func TestRuntimeAdmissionStartRechecksExpiryAfterAuthority(t *testing.T) {
	store, spec := runtimeFenceFixture(t)
	claim, err := store.Claim(spec, runtimeFenceNow)
	if err != nil {
		t.Fatal(err)
	}
	view, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest, func(context.Context, RuntimeAdmissionSpec) error {
		return nil
	}, func() time.Time { return time.Date(2026, 8, 31, 10, 20, 0, 0, time.UTC) })
	if !errors.Is(err, ErrAdmissionNotCurrent) || invoke || view != (RuntimeAdmissionView{}) {
		t.Fatalf("expired-after-authority view=%+v invoke=%v err=%v", view, invoke, err)
	}
	if current, err := store.Get(spec.RunID); err != nil || current.State != RuntimeAdmissionClaimed {
		t.Fatalf("expired start changed claim: %+v err=%v", current, err)
	}
}

func TestRuntimeAdmissionStopIsExactDurableAndNeverRestarts(t *testing.T) {
	store, spec := runtimeFenceFixture(t)
	claim, err := store.Claim(spec, runtimeFenceNow)
	if err != nil {
		t.Fatal(err)
	}
	started, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest,
		func(context.Context, RuntimeAdmissionSpec) error { return nil }, func() time.Time { return runtimeFenceNow.Add(time.Minute) })
	if err != nil || !invoke || started.StartDigest == nil {
		t.Fatalf("started=%+v invoke=%v err=%v", started, invoke, err)
	}
	stopped, err := store.Stop(spec.RunID, claim.AdmissionDigest, *started.StartDigest, RuntimeOutcomeCompleted, runtimeFenceNow.Add(2*time.Minute))
	if err != nil || stopped.State != RuntimeAdmissionStopped || stopped.Outcome == nil || *stopped.Outcome != RuntimeOutcomeCompleted {
		t.Fatalf("stopped=%+v err=%v", stopped, err)
	}
	replay, err := store.Stop(spec.RunID, claim.AdmissionDigest, *started.StartDigest, RuntimeOutcomeCompleted, runtimeFenceNow.Add(3*time.Minute))
	if err != nil || !reflect.DeepEqual(replay, stopped) {
		t.Fatalf("stop replay=%+v err=%v", replay, err)
	}
	if _, err := store.Stop(spec.RunID, claim.AdmissionDigest, *started.StartDigest, RuntimeOutcomeFailed, runtimeFenceNow.Add(3*time.Minute)); !errors.Is(err, ErrAdmissionConflict) {
		t.Fatalf("changed outcome error=%v", err)
	}
	called := false
	if replay, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest, func(context.Context, RuntimeAdmissionSpec) error {
		called = true
		return nil
	}, func() time.Time { return runtimeFenceNow.Add(4 * time.Minute) }); err != nil || invoke || called || !reflect.DeepEqual(replay, stopped) {
		t.Fatalf("stopped restart=%+v invoke=%v callback=%v err=%v", replay, invoke, called, err)
	}

	dataDir := filepath.Dir(filepath.Dir(store.root))
	owner := store.owner
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenRuntimeFenceStore(context.Background(), dataDir, owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	current, err := reopened.Get(spec.RunID)
	if err != nil || !reflect.DeepEqual(current, stopped) {
		t.Fatalf("reopened=%+v err=%v", current, err)
	}
}

func TestRuntimeAdmissionRecoveryClosesOnlyPossibleStartsAsUnknown(t *testing.T) {
	store, spec := runtimeFenceFixture(t)
	claim, err := store.Claim(spec, runtimeFenceNow)
	if err != nil {
		t.Fatal(err)
	}
	started, invoke, err := store.start(context.Background(), spec.RunID, claim.AdmissionDigest,
		func(context.Context, RuntimeAdmissionSpec) error { return nil }, func() time.Time { return runtimeFenceNow.Add(time.Minute) })
	if err != nil || !invoke || started.StartDigest == nil {
		t.Fatalf("started=%+v invoke=%v err=%v", started, invoke, err)
	}
	claimedOnly := spec
	claimedOnly.RunID = "run_runtimeclaimed002"
	claimedOnly.WorkspaceRef = "workspace_runtimeclaimed002"
	claimedOnly.WorkspaceGeneration = strings.Repeat("d", 64)
	claimedOnly.PreparedOperationID = "op_runtimeclaimed002"
	claimedOnly.PreparedIdentityDigest = strings.Repeat("d", 64)
	if _, err := store.Claim(claimedOnly, runtimeFenceNow); err != nil {
		t.Fatal(err)
	}
	recovered, err := store.RecoverUnknown(runtimeFenceNow.Add(2 * time.Minute))
	if err != nil || len(recovered) != 1 || recovered[0].State != RuntimeAdmissionStopped ||
		recovered[0].Outcome == nil || *recovered[0].Outcome != RuntimeOutcomeUnknown {
		t.Fatalf("recovered=%+v err=%v", recovered, err)
	}
	if current, err := store.Get(claimedOnly.RunID); err != nil || current.State != RuntimeAdmissionClaimed {
		t.Fatalf("claim-only changed during recovery: %+v err=%v", current, err)
	}
	if again, err := store.RecoverUnknown(runtimeFenceNow.Add(3 * time.Minute)); err != nil || len(again) != 0 {
		t.Fatalf("recovery replay=%+v err=%v", again, err)
	}
}

func TestRuntimeAdmissionFailsClosedOnOrphanAndDirectoryReplacement(t *testing.T) {
	t.Run("orphan stage", func(t *testing.T) {
		store, spec := runtimeFenceFixture(t)
		orphan := runtimeStartRecord{Version: 2, RunID: spec.RunID, AdmissionDigest: strings.Repeat("a", 64), AuthorityCheckedAt: profileTime(runtimeFenceNow)}
		raw, _ := json.Marshal(orphan)
		if err := os.WriteFile(store.path(spec.RunID, RuntimeAdmissionStarting), raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := store.List(); !errors.Is(err, ErrAdmissionChanged) {
			t.Fatalf("orphan error=%v", err)
		}
	})
	t.Run("replacement", func(t *testing.T) {
		store, spec := runtimeFenceFixture(t)
		if _, err := store.Claim(spec, runtimeFenceNow); err != nil {
			t.Fatal(err)
		}
		moved := store.root + ".replaced"
		if err := os.Rename(store.root, moved); err != nil {
			t.Skipf("directory replacement unavailable: %v", err)
		}
		if err := os.Mkdir(store.root, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := store.List(); !errors.Is(err, ErrAdmissionChanged) {
			t.Fatalf("replacement error=%v", err)
		}
	})
	t.Run("permissive record", func(t *testing.T) {
		store, spec := runtimeFenceFixture(t)
		if _, err := store.Claim(spec, runtimeFenceNow); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(store.path(spec.RunID, RuntimeAdmissionClaimed), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Get(spec.RunID); !errors.Is(err, ErrAdmissionChanged) {
			t.Fatalf("permissive record error=%v", err)
		}
	})
}

func runtimeFenceFixture(t *testing.T) (*RuntimeFenceStore, RuntimeAdmissionSpec) {
	t.Helper()
	manifest := runtimeManifestFixture(t)
	prepared, profile := runtimePrerequisites(manifest)
	spec, err := NewRuntimeAdmissionSpec(manifest, prepared, profile)
	if err != nil {
		t.Fatal(err)
	}
	dataDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	owner := Owner{ServerURL: "https://central.example.test", TeamID: "team_runtime0001",
		DeviceID: manifest.Scope.DeviceID, OwnerMemberID: "member_runtime0001"}
	store, err := OpenRuntimeFenceStore(context.Background(), dataDir, owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, spec
}

func runtimeManifestFixture(t *testing.T) execution.GovernedExecutionManifest {
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

func runtimePrerequisites(manifest execution.GovernedExecutionManifest) (repository.PreparedWorkspace, RuntimeProfileView) {
	prepared := repository.PreparedWorkspace{Version: 1, IntentDigest: strings.Repeat("c", 64), OperationID: "op_runtimeprepare001",
		RunID: manifest.Scope.RunID, WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
		BaseCommit: manifest.Repository.BaseCommit, PreparedCommit: strings.Repeat("b", 40), PreparedTree: strings.Repeat("c", 40),
		Branch: "refs/convenewire/secret", Path: "/owner-secret/worktree", GitDirectory: "/owner-secret/git", WorkIdentity: "identity:/owner-secret"}
	profile := RuntimeProfileView{Spec: RuntimeProfileSpec{ProfileID: manifest.Repository.RuntimeProfileID, Revision: 1,
		AgentID: manifest.Scope.AgentID, RuntimeKind: CodexRuntimeKind, ConfigurationDigest: strings.Repeat("d", 64), PermissionProfile: "workspace-write"},
		Digest: manifest.Repository.RuntimeProfileDigest, ExecutableDigest: strings.Repeat("e", 64), PermissionProfileDigest: strings.Repeat("f", 64),
		FilesystemBoundary: FilesystemBoundaryName, NetworkBoundary: NetworkBoundaryName, Platform: "darwin/arm64",
		RegisteredAt: profileTime(time.Date(2026, 8, 31, 9, 0, 0, 0, time.UTC))}
	return prepared, profile
}
