package repository

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

func cleanupGrantFixture(t *testing.T, format string) (*fixture, *BindingStore, CleanupGrantSpec, CleanupScope) {
	t.Helper()
	f, store, _, manifest := taskGrantFixture(t, format)
	scope := CleanupScope{OperationID: "op_cleanup_owner0001",
		CheckpointID: "checkpoint_owner0001", CheckpointDigest: strings.Repeat("c", 64),
		RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
		RunID: manifest.Scope.RunID, AgentID: manifest.Scope.AgentID, DeviceID: manifest.Scope.DeviceID,
		WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
		ManifestDigest: manifest.ManifestDigest, PlanID: manifest.Scope.PlanID,
		PlanRevision: manifest.Scope.PlanRevision, NodeKey: manifest.Scope.NodeKey, TaskID: manifest.Scope.TaskID}
	spec := CleanupGrantSpec{GrantID: "cleanupgrant_owner0001", OperationID: scope.OperationID,
		CheckpointID: scope.CheckpointID, CheckpointDigest: scope.CheckpointDigest,
		RepositoryID: scope.RepositoryID, BindingID: scope.BindingID, RunID: scope.RunID,
		AgentID: scope.AgentID, DeviceID: scope.DeviceID, WorkspaceRef: scope.WorkspaceRef,
		Generation: scope.Generation, ManifestDigest: scope.ManifestDigest, PlanID: scope.PlanID,
		PlanRevision: scope.PlanRevision, NodeKey: scope.NodeKey, TaskID: scope.TaskID,
		ExpiresAt: bindingTime(bindingNow.Add(time.Hour))}
	return f, store, spec, scope
}

func TestCleanupGrantIsExactCurrentRevocableAndLocalOnly(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f, store, spec, scope := cleanupGrantFixture(t, format)
			view, err := store.IssueCleanupGrant(context.Background(), spec, bindingNow)
			if err != nil || view.Revision != 1 || view.Digest == "" || view.RevokedAt != nil {
				t.Fatalf("view=%+v err=%v", view, err)
			}
			listed, err := store.ListCleanupGrants()
			if err != nil || !reflect.DeepEqual(listed, []CleanupGrantView{view}) {
				t.Fatalf("listed=%+v err=%v", listed, err)
			}
			ordinary, err := store.ListTaskGrants()
			if err != nil || len(ordinary) != 0 {
				t.Fatalf("cleanup consent leaked into Runtime grants: %+v err=%v", ordinary, err)
			}
			called := 0
			if err := store.WithCleanupGrantAuthority(context.Background(), spec.GrantID,
				scope, bindingNow.Add(time.Minute), func() error { called++; return nil }); err != nil || called != 1 {
				t.Fatalf("authority calls=%d err=%v", called, err)
			}
			for name, change := range map[string]func(*CleanupScope){
				"checkpoint": func(v *CleanupScope) { v.CheckpointDigest = strings.Repeat("d", 64) },
				"run":        func(v *CleanupScope) { v.RunID = "run_foreign0001" },
				"workspace":  func(v *CleanupScope) { v.WorkspaceRef = "workspace_foreign0001" },
				"plan":       func(v *CleanupScope) { v.PlanRevision++ },
			} {
				t.Run(name, func(t *testing.T) {
					candidate := scope
					change(&candidate)
					if err := store.WithCleanupGrantAuthority(context.Background(), spec.GrantID,
						candidate, bindingNow.Add(time.Minute), func() error { t.Fatal("drifted cleanup ran"); return nil }); !errors.Is(err, ErrGrantDenied) {
						t.Fatalf("error=%v", err)
					}
				})
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := OpenBindingStore(context.Background(), store.dataRoot,
				store.owner, f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			replay, err := reopened.IssueCleanupGrant(context.Background(), spec, bindingNow)
			if err != nil || !reflect.DeepEqual(replay, view) {
				t.Fatalf("replay=%+v err=%v", replay, err)
			}
			revoked, err := reopened.RevokeCleanupGrant(spec.GrantID, 1, view.Digest,
				bindingNow.Add(2*time.Minute))
			if err != nil || revoked.Revision != 2 || revoked.RevokedAt == nil {
				t.Fatalf("revoked=%+v err=%v", revoked, err)
			}
			if err := reopened.WithCleanupGrantAuthority(context.Background(), spec.GrantID,
				scope, bindingNow.Add(3*time.Minute), func() error { t.Fatal("revoked cleanup ran"); return nil }); !errors.Is(err, ErrGrantRevoked) {
				t.Fatalf("revoked error=%v", err)
			}
		})
	}
}

func TestCleanupGrantRejectsExpiryAndBindingRevocation(t *testing.T) {
	_, store, spec, scope := cleanupGrantFixture(t, "sha1")
	if _, err := store.IssueCleanupGrant(context.Background(), spec, time.Time{}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("zero issuance time error=%v", err)
	}
	expired := spec
	expired.GrantID = "cleanupgrant_expired0001"
	expired.ExpiresAt = bindingNow.Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := store.IssueCleanupGrant(context.Background(), expired, bindingNow); !errors.Is(err, ErrGrantExpired) {
		t.Fatalf("expired issuance error=%v", err)
	}
	if _, err := store.IssueCleanupGrant(context.Background(), spec, bindingNow); err != nil {
		t.Fatal(err)
	}
	if err := store.WithCleanupGrantAuthority(context.Background(), spec.GrantID, scope,
		bindingNow.Add(2*time.Hour), func() error { t.Fatal("expired cleanup ran"); return nil }); !errors.Is(err, ErrGrantExpired) {
		t.Fatalf("expired error=%v", err)
	}
	if _, err := store.Revoke(spec.BindingID, 1, bindingNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.WithCleanupGrantAuthority(context.Background(), spec.GrantID, scope,
		bindingNow.Add(time.Minute), func() error { t.Fatal("revoked binding cleanup ran"); return nil }); !errors.Is(err, ErrBindingRevoked) {
		t.Fatalf("binding revocation error=%v", err)
	}
}
