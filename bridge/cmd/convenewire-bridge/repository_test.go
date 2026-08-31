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
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
)

func TestRepositoryCommandRequiresExplicitOwnerInputs(t *testing.T) {
	for _, args := range [][]string{{}, {"unknown"}, {"bind"}, {"bind", "--binding-id", "repobind_test0001"},
		{"bind", "--confirm", "--binding-id", "repobind_test0001"}, {"revoke", "--confirm", "--binding-id", "repobind_test0001"},
		{"list", "--workspace", "/private"}, {"list", "unexpected"}, {"bind", "--allowed-root", "relative"}} {
		if err := repositoryCommand(args, &bytes.Buffer{}, time.Now); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if err := run([]string{"repository", "unknown"}); err == nil {
		t.Fatal("main dispatch accepted unknown repository action")
	}
}

func TestRepositoryCommandRegistersListsAndRevokesWithoutRuntimeOrNetwork(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := filepath.Join(root, "source")
	data := filepath.Join(root, "data")
	for _, directory := range []string{repo, data} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(git, "init", "--template=", "-b", "main", repo)
	command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("Git: %v %s", err, output)
	}
	cfg := config.Config{ServerURL: "http://127.0.0.1:1", DeviceName: "Binding test", DataDir: data,
		Agents: []config.AgentConfig{{Name: "Builder", Role: "Builder", Adapter: "generic",
			Command: []string{"must-never-start-this-runtime"}, Workspace: repo}}}
	configPath := filepath.Join(root, "bridge.json")
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	credential := pairing.Credential{ServerURL: cfg.ServerURL, DeviceID: "device_binding_cli0001", TeamID: "team_binding_cli0001",
		OwnerMemberID: "member_binding_cli0001", Token: strings.Repeat("secret", 8)}
	if err := pairing.Save(data, credential); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 13, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	invoke := func(args ...string) (string, error) {
		var output bytes.Buffer
		err := repositoryCommand(append(args, "--config", configPath), &output, clock)
		if strings.Contains(output.String(), root) || strings.Contains(output.String(), credential.Token) {
			t.Fatal("local inventory leaked path or credential")
		}
		return output.String(), err
	}
	bind := []string{"bind", "--confirm", "--binding-id", "repobind_cli00001", "--repository-id", "repo_cli00001",
		"--alias", "Test repository", "--workspace", repo, "--allowed-root", repo}
	first, err := invoke(bind...)
	if err != nil {
		t.Fatal(err)
	}
	second, err := invoke(bind...)
	if err != nil || first != second {
		t.Fatalf("replay=%s %v", second, err)
	}
	listed, err := invoke("list")
	if err != nil {
		t.Fatal(err)
	}
	var views []repository.BindingView
	if json.Unmarshal([]byte(listed), &views) != nil || len(views) != 1 || views[0].Revision != 1 {
		t.Fatal(listed)
	}
	owner, err := ownership.Acquire(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := invoke("revoke", "--confirm", "--binding-id", "repobind_cli00001", "--expected-revision", "1"); err == nil {
		t.Fatal("CLI bypassed the live Bridge owner")
	}
	if err := owner.Release(); err != nil {
		t.Fatal(err)
	}
	expired := now.Add(-time.Hour).Format(time.RFC3339Nano)
	previous := credential
	credential.ExpiresAt = &expired
	if err := pairing.Replace(data, previous, credential); err != nil {
		t.Fatal(err)
	}
	if _, err := invoke(bind...); err == nil {
		t.Fatal("expired credential registered consent")
	}
	// Revocation is local authority reduction: it remains available without Git,
	// an existing source checkout, Runtime executable or a network connection.
	if err := os.Rename(repo, repo+"-retained"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", root)
	revoked, err := invoke("revoke", "--confirm", "--binding-id", "repobind_cli00001", "--expected-revision", "1")
	if err != nil {
		t.Fatal(err)
	}
	var view repository.BindingView
	if json.Unmarshal([]byte(revoked), &view) != nil || view.Revision != 2 || view.RevokedAt == nil {
		t.Fatal(revoked)
	}
	if _, err := os.Stat(filepath.Join(data, "inbox")); !os.IsNotExist(err) {
		t.Fatal("repository administration started Run machinery")
	}
	if _, err := os.Stat(filepath.Join(data, "agent-identities.json")); !os.IsNotExist(err) {
		t.Fatal("repository administration provisioned Agents")
	}
	previous = credential
	credential.ServerURL = "https://different.example.invalid"
	if err := pairing.Replace(data, previous, credential); err != nil {
		t.Fatal(err)
	}
	if _, err := invoke("list"); err == nil {
		t.Fatal("cross-Central credential accepted")
	}
}
