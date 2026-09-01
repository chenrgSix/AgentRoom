package admission

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
)

func TestGovernedAdmissionResourcesOwnAndReleaseCompleteLocalComposition(t *testing.T) {
	dataDir, git, cfg, credential, agents := governedResourcesFixture(t)
	resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, agents)
	if err != nil {
		t.Fatal(err)
	}
	if resources.Coordinator() == nil || resources.RecoveryFence() == nil ||
		resources.ProcessTracker() == nil || resources.ProcessFencer() == nil {
		t.Fatal("resources did not construct admission and restricted recovery")
	}
	if second, err := ownership.Acquire(dataDir); err == nil {
		_ = second.Release()
		t.Fatal("resources did not retain the data-root owner")
	}
	preparationRoot := filepath.Join(dataDir, governedPreparationDirectory)
	if second, err := repository.NewPreparer(preparationRoot, git, repository.Limits{}); err == nil {
		_ = second.Close()
		t.Fatal("resources did not retain the preparation owner")
	}
	if err := resources.Close(); err != nil {
		t.Fatal(err)
	}
	if resources.Coordinator() != nil {
		t.Fatal("closed resources retained the coordinator")
	}
	if resources.RecoveryFence() != nil {
		t.Fatal("closed resources retained the recovery fence")
	}
	if resources.ProcessTracker() != nil || resources.ProcessFencer() != nil {
		t.Fatal("closed resources retained process lifecycle access")
	}
	if err := resources.Close(); err != nil {
		t.Fatalf("close replay failed: %v", err)
	}
	owner, err := ownership.Acquire(dataDir)
	if err != nil {
		t.Fatalf("resources retained data-root owner after close: %v", err)
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}
	preparer, err := repository.NewPreparer(preparationRoot, git, repository.Limits{})
	if err != nil {
		t.Fatalf("resources retained preparation owner after close: %v", err)
	}
	if err := preparer.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestGovernedAdmissionResourcesBorrowOwnerAndRollbackFailure(t *testing.T) {
	dataDir, git, cfg, credential, agents := governedResourcesFixture(t)
	owner, err := ownership.Acquire(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := ownership.WithOwner(context.Background(), owner)
	resources, err := OpenGovernedAdmissionResources(ctx, cfg, credential, git, agents)
	if err != nil {
		t.Fatal(err)
	}
	if err := resources.Close(); err != nil {
		t.Fatal(err)
	}
	if second, err := ownership.Acquire(dataDir); err == nil {
		_ = second.Release()
		t.Fatal("borrowed resources released the outer owner")
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}

	if _, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, nil); err == nil {
		t.Fatal("empty Agent authority constructed resources")
	}
	reacquired, err := ownership.Acquire(dataDir)
	if err != nil {
		t.Fatalf("failed composition retained data-root owner: %v", err)
	}
	if err := reacquired.Release(); err != nil {
		t.Fatal(err)
	}
	preparer, err := repository.NewPreparer(filepath.Join(dataDir, governedPreparationDirectory), git, repository.Limits{})
	if err != nil {
		t.Fatalf("failed composition retained preparation owner: %v", err)
	}
	if err := preparer.Close(); err != nil {
		t.Fatal(err)
	}
}

func governedResourcesFixture(t *testing.T) (string, string, config.Config, pairing.Credential, map[string]config.AgentConfig) {
	t.Helper()
	dataDir := t.TempDir()
	dataDir, err := filepath.EvalSymlinks(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("Git is unavailable")
	}
	git, err = filepath.Abs(git)
	if err != nil {
		t.Fatal(err)
	}
	serverURL := "https://team.example.com"
	cfg := config.Config{ServerURL: serverURL, DataDir: dataDir}
	credential := pairing.Credential{ServerURL: serverURL, TeamID: "team_runtime0001",
		DeviceID: "device_runtime0001", OwnerMemberID: "member_runtime0001", Token: "device-secret"}
	agents := map[string]config.AgentConfig{"agent_runtime0001": {Name: "Builder", Adapter: "codex",
		RuntimeKind: "codex", PresetVersion: config.CurrentPresetVersion,
		Command: []string{"codex", "app-server", "--listen", "stdio://"}, Sandbox: "workspace-write"}}
	return dataDir, git, cfg, credential, agents
}
