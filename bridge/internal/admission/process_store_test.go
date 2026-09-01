package admission

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

func TestGovernedProcessStoreAbandonsPreparedOnlyLeaseAcrossRestart(t *testing.T) {
	store, dataDir, owner := governedProcessStoreFixture(t)
	identity := governedProcessIdentityFixture()
	lease, err := store.PrepareProcess(identity)
	if err != nil || lease.InheritedLockFile() == nil {
		t.Fatalf("lease=%v err=%v", lease, err)
	}
	entries, err := os.ReadDir(store.root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(store.root, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{dataDir, "codex", "/owner-secret"} {
			if strings.Contains(string(raw), forbidden) {
				t.Fatalf("process record exposed %q: %s", forbidden, raw)
			}
		}
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenGovernedProcessStore(context.Background(), dataDir, owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	if err := reopened.FenceAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := reopened.FenceAndWait(context.Background(), governedProcessAdmissionView(identity)); err != nil {
		t.Fatalf("exact abandoned replay failed: %v", err)
	}
	if err := reopened.RequireFinished(identity); !errors.Is(err, ErrAdmissionChanged) {
		t.Fatalf("prepared-only abandonment became finished proof: %v", err)
	}
	view, err := reopened.get(identity.RunID)
	if err != nil || view.terminalStage != governedProcessAbandoned || view.active != nil {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	if _, err := os.Lstat(reopened.lockPath(identity.RunID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("abandoned lock remains: %v", err)
	}
}

func TestGovernedProcessStoreRejectsOrphanStageAndDirectoryReplacement(t *testing.T) {
	t.Run("orphan active", func(t *testing.T) {
		store, _, _ := governedProcessStoreFixture(t)
		identity := governedProcessIdentityFixture()
		record := governedProcessActiveRecord{Version: 2, RunID: identity.RunID,
			PreparedDigest: strings.Repeat("a", 64),
			Observation:    bridgeruntime.GovernedProcessObservation{PID: 99999, PlatformIdentity: "process-group:99999"},
			StartedAt:      profileTime(time.Now().UTC())}
		raw, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if err := writeExclusive(store.path(identity.RunID, governedProcessActive), raw); err != nil {
			t.Fatal(err)
		}
		if err := store.FenceAll(context.Background()); !errors.Is(err, ErrAdmissionChanged) {
			t.Fatalf("error=%v", err)
		}
	})

	t.Run("replaced root", func(t *testing.T) {
		store, _, _ := governedProcessStoreFixture(t)
		moved := store.root + "-moved"
		if err := os.Rename(store.root, moved); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(store.root, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := store.FenceAll(context.Background()); !errors.Is(err, ErrAdmissionChanged) {
			t.Fatalf("error=%v", err)
		}
	})
}

func TestGovernedProcessStoreRejectsChangedRecoveryIdentity(t *testing.T) {
	store, _, _ := governedProcessStoreFixture(t)
	identity := governedProcessIdentityFixture()
	lease, err := store.PrepareProcess(identity)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Abandon() })
	changed := identity
	changed.StartDigest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	if err := store.FenceAndWait(context.Background(), governedProcessAdmissionView(changed)); !errors.Is(err, ErrAdmissionConflict) {
		t.Fatalf("error=%v", err)
	}
}

func governedProcessStoreFixture(t *testing.T) (*GovernedProcessStore, string, Owner) {
	t.Helper()
	dataDir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	owner := Owner{ServerURL: "https://team.example.com", TeamID: "team_processstore01",
		DeviceID: "device_processstore01", OwnerMemberID: "member_processstore01"}
	store, err := OpenGovernedProcessStore(context.Background(), dataDir, owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, dataDir, owner
}

func governedProcessIdentityFixture() bridgeruntime.GovernedProcessIdentity {
	return bridgeruntime.GovernedProcessIdentity{RunID: "run_processstore001",
		AdmissionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		StartDigest:     "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
}
