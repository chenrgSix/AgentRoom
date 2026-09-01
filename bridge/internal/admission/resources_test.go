package admission

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	"convenewire.dev/bridge/internal/verification"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestGovernedAdmissionResourcesOwnAndReleaseCompleteLocalComposition(t *testing.T) {
	dataDir, git, cfg, credential, agents := governedResourcesFixture(t)
	resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, agents)
	if err != nil {
		t.Fatal(err)
	}
	if resources.Coordinator() == nil || resources.VerificationCoordinator() == nil || resources.IntegrationCoordinator() == nil ||
		resources.RecoveryFence() == nil ||
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
	if resources.VerificationCoordinator() != nil {
		t.Fatal("closed resources retained the verification coordinator")
	}
	if resources.IntegrationCoordinator() != nil {
		t.Fatal("closed resources retained the integration coordinator")
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

	recoveryOnly, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, nil)
	if err != nil {
		t.Fatalf("empty Agent inventory could not open recovery resources: %v", err)
	}
	if recoveryOnly.Coordinator() != nil || recoveryOnly.RecoveryFence() == nil ||
		recoveryOnly.ProcessFencer() == nil {
		t.Fatal("empty Agent inventory enabled admission or omitted recovery")
	}
	if coordinator, err := recoveryOnly.CleanupCoordinator("cleanupgrant_resources0001"); err != nil || coordinator == nil {
		t.Fatalf("empty Agent inventory omitted owner cleanup recovery: coordinator=%v err=%v", coordinator, err)
	}
	if ready, err := recoveryOnly.ReadyAgentGrants(context.Background(), time.Now()); err != nil || len(ready) != 0 {
		t.Fatalf("recovery-only resources reported readiness: %#v %v", ready, err)
	}
	if err := recoveryOnly.Close(); err != nil {
		t.Fatal(err)
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

func TestGovernedAdmissionResourcesReadinessRequiresCurrentProfileGrantAndBinding(t *testing.T) {
	_, git, cfg, credential, agents := governedResourcesFixture(t)
	resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, agents)
	if err != nil {
		t.Fatal(err)
	}
	defer resources.Close()
	now := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	if ready, err := resources.ReadyAgentGrants(context.Background(), now); err != nil || len(ready) != 0 {
		t.Fatalf("unconfigured resources reported readiness: %#v %v", ready, err)
	}

	repositoryRoot := t.TempDir()
	repositoryRoot, err = filepath.EvalSymlinks(repositoryRoot)
	if err != nil {
		t.Fatal(err)
	}
	runResourceGit(t, git, repositoryRoot, "init")
	runResourceGit(t, git, repositoryRoot, "config", "user.name", "ConveneWire Test")
	runResourceGit(t, git, repositoryRoot, "config", "user.email", "test@example.com")
	if err := os.Mkdir(filepath.Join(repositoryRoot, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repositoryRoot, "src", "app.txt"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runResourceGit(t, git, repositoryRoot, "add", "--", "src/app.txt")
	runResourceGit(t, git, repositoryRoot, "commit", "-m", "base")
	base := strings.TrimSpace(runResourceGit(t, git, repositoryRoot, "rev-parse", "HEAD"))
	binding, err := resources.bindings.Bind(context.Background(), repository.BindRepository{
		BindingID: "repobind_ready0001", RepositoryID: "repo_ready0001", Alias: "Ready source",
		SelectedRoot: repositoryRoot, AllowedRoots: []string{repositoryRoot}}, now)
	if err != nil {
		t.Fatal(err)
	}
	agentID := "agent_runtime0001"
	agent := agents[agentID]
	configurationDigest, err := CodexConfigurationDigest(agent, agentID, "convenewire_governed")
	if err != nil {
		t.Fatal(err)
	}
	profile, err := resources.profiles.registerCodex(context.Background(), CodexRegistration{Spec: RuntimeProfileSpec{
		ProfileID: "profile_ready0001", Revision: 1, AgentID: agentID, RuntimeKind: CodexRuntimeKind,
		ConfigurationDigest: configurationDigest, PermissionProfile: "convenewire_governed"}, Agent: agent}, now,
		fixedProber("convenewire_governed"))
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := resources.verifiers.Register(verification.ProfileSpec{
		ProfileID: "profile_verify0001", Revision: 1,
		Command: []string{git, "--version"}, EnvironmentNames: []string{"PATH"},
		TimeoutMilliseconds: 5_000, OutputLimitBytes: 4_096,
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	grantSpec := repository.TaskGrantSpec{
		GrantID: "grant_ready0001", BindingID: binding.BindingID, BindingRevision: binding.Revision,
		SourceFingerprint: binding.SourceFingerprint, RepositoryID: binding.RepositoryID, BaseCommit: base,
		PlanID: "plan_ready0001", PlanRevision: 1, PlanDigest: strings.Repeat("a", 64), NodeKey: "build",
		RoomID: "room_ready0001", TaskID: "task_ready0001", DefinitionRevision: 1, CriteriaRevision: 1,
		AgentID: agentID, ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano),
		Operations: []execution.KindElement{execution.Prepare}, RuntimeProfile: execution.ExecutionGrantSummaryRuntimeProfile{
			ProfileID: profile.Spec.ProfileID, Revision: profile.Spec.Revision, Digest: profile.Digest},
		VerificationProfiles: []execution.ExecutionGrantSummaryVerificationProfile{{
			ProfileID: verifier.ProfileID, Revision: verifier.Revision, Digest: verifier.Digest,
		}},
		ScopePolicy: execution.ExecutionGrantSummaryScopePolicy{Access: execution.IsolatedWrite,
			AllowedPaths: []string{"src"}, ForbiddenPaths: []string{}},
		IntegrationTargets: []execution.ExecutionGrantSummaryIntegrationTarget{}}
	if _, err := resources.bindings.IssueTaskGrant(context.Background(), grantSpec, now); err != nil {
		t.Fatal(err)
	}
	if ready, err := resources.ReadyAgentGrants(context.Background(), now.Add(time.Minute)); err != nil || len(ready) != 0 {
		t.Fatalf("prepare-only grant reported capture readiness: %#v %v", ready, err)
	}
	grantSpec.GrantID = "grant_ready0002"
	grantSpec.Operations = []execution.KindElement{execution.Prepare, execution.Capture, execution.Verify}
	grant, err := resources.bindings.IssueTaskGrant(context.Background(), grantSpec, now)
	if err != nil {
		t.Fatal(err)
	}
	ready, err := resources.ReadyAgentGrants(context.Background(), now.Add(time.Minute))
	if err != nil || len(ready) != 1 || len(ready[agentID]) != 1 {
		t.Fatalf("valid local authority chain was not ready: %#v %v", ready, err)
	}
	if len(ready[agentID]) != 1 || ready[agentID][0].Grant.GrantID != grant.Spec.GrantID {
		t.Fatalf("readiness did not publish the exact capture grant: %#v", ready)
	}
	if ready, err := resources.ReadyAgentGrants(context.Background(), now.Add(2*time.Hour)); err != nil || len(ready) != 0 {
		t.Fatalf("expired grant remained ready: %#v %v", ready, err)
	}
	if _, err := resources.bindings.RevokeTaskGrant(grant.Spec.GrantID, 1, grant.Summary.Grant.Digest,
		now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if ready, err := resources.ReadyAgentGrants(context.Background(), now.Add(11*time.Minute)); err != nil || len(ready) != 0 {
		t.Fatalf("revoked grant remained ready: %#v %v", ready, err)
	}
	grantSpec.GrantID = "grant_ready0003"
	grantSpec.Operations = []execution.KindElement{execution.Integrate}
	grantSpec.VerificationProfiles = []execution.ExecutionGrantSummaryVerificationProfile{}
	grantSpec.IntegrationTargets = []execution.ExecutionGrantSummaryIntegrationTarget{{
		RepositoryID: binding.RepositoryID, TargetRef: "refs/heads/release", ExpectedCommit: base,
	}}
	integration, err := resources.bindings.IssueTaskGrant(context.Background(), grantSpec, now)
	if err != nil {
		t.Fatal(err)
	}
	ready, err = resources.ReadyAgentGrants(context.Background(), now.Add(12*time.Minute))
	if err != nil || len(ready) != 1 || len(ready[agentID]) != 1 ||
		ready[agentID][0].Grant.GrantID != integration.Summary.Grant.GrantID {
		t.Fatalf("integration-only authority chain was not ready: %#v %v", ready, err)
	}
}

func TestGovernedAdmissionResourcesWithoutGitRetainRecoveryButDisableAdmission(t *testing.T) {
	_, _, cfg, credential, agents := governedResourcesFixture(t)
	resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, "", agents)
	if err != nil {
		t.Fatal(err)
	}
	defer resources.Close()
	if resources.Coordinator() != nil || resources.RecoveryFence() == nil || resources.ProcessFencer() == nil {
		t.Fatal("missing Git enabled admission or disabled mandatory recovery")
	}
	if ready, err := resources.ReadyAgentGrants(context.Background(), time.Now()); err != nil || len(ready) != 0 {
		t.Fatalf("missing Git reported governed readiness: %#v %v", ready, err)
	}
}

func TestGovernedAdmissionResourcesCanonicalizeParentAliasButRejectLinkedLeaf(t *testing.T) {
	_, git, cfg, credential, agents := governedResourcesFixture(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	actualParent := filepath.Join(base, "actual")
	dataDir := filepath.Join(actualParent, "data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(actualParent, alias); err != nil {
		t.Skipf("directory symlinks are unavailable: %v", err)
	}
	cfg.DataDir = filepath.Join(alias, "data")
	resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, agents)
	if err != nil {
		t.Fatalf("safe parent alias was rejected: %v", err)
	}
	if err := resources.Close(); err != nil {
		t.Fatal(err)
	}

	linkedLeaf := filepath.Join(base, "linked-data")
	if err := os.Symlink(dataDir, linkedLeaf); err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = linkedLeaf
	if resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, agents); err == nil {
		_ = resources.Close()
		t.Fatal("symlinked data-directory leaf was accepted")
	}
}

func runResourceGit(t *testing.T, git, directory string, args ...string) string {
	t.Helper()
	command := exec.Command(git, append([]string{"-C", directory}, args...)...)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return string(output)
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
