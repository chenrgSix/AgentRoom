package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestRepositoryGrantCommandRequiresExplicitScopeAndConfirmation(t *testing.T) {
	for _, args := range [][]string{{"grant"}, {"grant", "shell"}, {"grant", "issue"}, {"grant", "issue", "--file", "/missing"},
		{"grant", "issue", "--confirm", "--file", "relative"}, {"grant", "list", "--confirm"}, {"grant", "list", "extra"},
		{"grant", "revoke", "--confirm", "--grant-id", "grant_example001"}} {
		if err := repositoryCommand(args, &bytes.Buffer{}, time.Now); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if err := run([]string{"repository", "grant", "shell"}); err == nil {
		t.Fatal("main dispatcher accepted arbitrary operation")
	}
}

func TestRepositoryGrantCLIHasExactOwnerConsentAndOfflineRevocation(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo, data := filepath.Join(root, "source"), filepath.Join(root, "data")
	for _, dir := range []string{repo, data} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	gitRun := func(args ...string) string {
		t.Helper()
		cmd := exec.Command(git, append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid", "GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("Git %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	gitRun("init", "--template=", "-b", "main")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	gitRun("add", "README.md")
	gitRun("commit", "-m", "fixture")
	base := gitRun("rev-parse", "HEAD")
	cfg := config.Config{ServerURL: "http://127.0.0.1:1", DeviceName: "Grant fixture", DataDir: data,
		Agents: []config.AgentConfig{{Name: "Builder", Role: "Builder", Adapter: "generic", Command: []string{"must-never-start-runtime"}, Workspace: repo}}}
	configPath := filepath.Join(root, "bridge.json")
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	credential := pairing.Credential{ServerURL: cfg.ServerURL, TeamID: "team_grantcli0001", DeviceID: "device_grantcli0001", OwnerMemberID: "member_grantcli0001", Token: strings.Repeat("secret", 8)}
	if err := pairing.Save(data, credential); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	invoke := func(args ...string) (string, error) {
		t.Helper()
		var out bytes.Buffer
		err := repositoryCommand(append(args, "--config", configPath), &out, func() time.Time { return now })
		if strings.Contains(out.String(), root) || strings.Contains(out.String(), credential.Token) {
			t.Fatal("CLI output exposed path or credential")
		}
		return out.String(), err
	}
	bound, err := invoke("bind", "--confirm", "--binding-id", "repobind_grantcli0001", "--repository-id", "repo_grantcli0001", "--alias", "Fixture", "--workspace", repo, "--allowed-root", repo)
	if err != nil {
		t.Fatal(err)
	}
	var binding repository.BindingView
	if json.Unmarshal([]byte(bound), &binding) != nil {
		t.Fatal(bound)
	}
	spec := repository.TaskGrantSpec{GrantID: "grant_cli00001", BindingID: binding.BindingID, BindingRevision: 1, SourceFingerprint: binding.SourceFingerprint,
		RepositoryID: binding.RepositoryID, BaseCommit: base, PlanID: "plan_cli00001", PlanRevision: 1, PlanDigest: strings.Repeat("a", 64), NodeKey: "backend",
		RoomID: "room_cli00001", TaskID: "task_cli00001", DefinitionRevision: 1, CriteriaRevision: 1, AgentID: "agent_cli00001", ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano),
		Operations: []execution.KindElement{execution.Prepare, execution.Capture}, RuntimeProfile: execution.ExecutionGrantSummaryRuntimeProfile{ProfileID: "profile_cli00001", Revision: 1, Digest: strings.Repeat("b", 64)},
		VerificationProfiles: []execution.ExecutionGrantSummaryVerificationProfile{}, ScopePolicy: execution.ExecutionGrantSummaryScopePolicy{Access: execution.IsolatedWrite, AllowedPaths: []string{"src"}, ForbiddenPaths: []string{}}, IntegrationTargets: []execution.ExecutionGrantSummaryIntegrationTarget{}}
	file := filepath.Join(root, "grant.json")
	writeSpec := func() {
		t.Helper()
		raw, _ := json.Marshal(spec)
		if err := os.WriteFile(file, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeSpec()
	issue := []string{"grant", "issue", "--file", file, "--confirm"}
	if _, err := invoke(issue...); err == nil {
		t.Fatal("issuance fabricated an Agent identity")
	}
	if _, err := os.Stat(filepath.Join(data, "agent-identities.json")); !os.IsNotExist(err) {
		t.Fatal("issuance provisioned Agent identities")
	}
	if err := identity.BindName(data, "Builder", spec.AgentID); err != nil {
		t.Fatal(err)
	}
	first, err := invoke(issue...)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := invoke(issue...)
	if err != nil || first != replay {
		t.Fatalf("changed replay: %v", err)
	}
	var view repository.TaskGrantView
	if json.Unmarshal([]byte(first), &view) != nil {
		t.Fatal(first)
	}
	listed, err := invoke("grant", "list")
	if err != nil || !strings.Contains(listed, view.Summary.Grant.Digest) {
		t.Fatal(err)
	}
	spec.ScopePolicy.AllowedPaths = []string{"."}
	writeSpec()
	if _, err := invoke(issue...); err == nil {
		t.Fatal("changed grant reused consent")
	}
	owner, err := ownership.Acquire(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := invoke("grant", "list"); err == nil {
		t.Fatal("CLI bypassed live Bridge owner")
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}
	previous := credential
	expired := now.Add(-time.Hour).Format(time.RFC3339Nano)
	credential.ExpiresAt = &expired
	if err := pairing.Replace(data, previous, credential); err != nil {
		t.Fatal(err)
	}
	if _, err := invoke(issue...); err == nil {
		t.Fatal("expired Device credential issued grant")
	}
	if gitRun("rev-parse", "HEAD") != base || gitRun("status", "--porcelain") != "" {
		t.Fatal("grant command mutated source Git")
	}
	if err := os.Rename(repo, repo+"-retained"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root)
	revoke := []string{"grant", "revoke", "--confirm", "--grant-id", spec.GrantID, "--expected-revision", "1", "--expected-digest", view.Summary.Grant.Digest}
	revoked, err := invoke(revoke...)
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(revoked), &view) != nil || view.Summary.RevokedAt == nil || view.Summary.Grant.Revision != 2 {
		t.Fatal(revoked)
	}
	replayed, err := invoke(revoke...)
	if err != nil || replayed != revoked {
		t.Fatal("revocation was not idempotent", err)
	}
	if _, err := os.Stat(filepath.Join(data, "inbox")); !os.IsNotExist(err) {
		t.Fatal("grant setup started Run machinery")
	}
	previous = credential
	credential.ServerURL = "https://foreign.example.invalid"
	if err := pairing.Replace(data, previous, credential); err != nil {
		t.Fatal(err)
	}
	if _, err := invoke("grant", "list"); err == nil {
		t.Fatal("cross-Central consent visible")
	}
}

func TestRepositoryGrantFileRejectsSymlinkDirectoryAndOversize(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "grant.json")
	if err := os.WriteFile(file, []byte(strings.Repeat(" ", (64<<10)+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{dir, file, "relative"} {
		if _, err := readTaskGrantSpec(path); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(file, link); err == nil {
		if _, err := readTaskGrantSpec(link); err == nil {
			t.Fatal("symlink grant accepted")
		}
	}
}
