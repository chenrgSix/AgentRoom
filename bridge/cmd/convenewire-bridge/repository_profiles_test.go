package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/admission"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/ownership"
	"convenewire.dev/bridge/internal/pairing"
)

func TestRepositoryProfileCommandRequiresExactOwnerInputs(t *testing.T) {
	for _, args := range [][]string{{"profile"}, {"profile", "shell"}, {"profile", "register"},
		{"profile", "register", "--confirm", "--profile-id", "profile_runtime0001"},
		{"profile", "list", "--confirm"}, {"profile", "list", "extra"},
		{"profile", "revoke", "--confirm", "--profile-id", "profile_runtime0001"}} {
		if err := repositoryCommand(args, &bytes.Buffer{}, time.Now); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if err := run([]string{"repository", "profile", "shell"}); err == nil {
		t.Fatal("main dispatcher accepted an arbitrary profile action")
	}
}

func TestRepositoryProfileCLIRegistersListsAndRevokesOnlyProvenBoundary(t *testing.T) {
	root, configPath, data, credential := repositoryProfileFixture(t, "safe")
	now := time.Date(2026, 9, 1, 15, 0, 0, 0, time.UTC)
	invoke := func(args ...string) (string, error) {
		t.Helper()
		var output bytes.Buffer
		err := repositoryCommand(append(args, "--config", configPath), &output, func() time.Time { return now })
		if strings.Contains(output.String(), root) || strings.Contains(output.String(), credential.Token) || strings.Contains(output.String(), "HOME=") {
			t.Fatal("profile inventory exposed local path, environment or credential")
		}
		return output.String(), err
	}
	register := []string{"profile", "register", "--confirm", "--profile-id", "profile_runtime0001",
		"--agent-id", "agent_profile0001", "--permission-profile", "convenewire_governed"}
	first, err := invoke(register...)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := invoke(register...)
	if err != nil || replay != first {
		t.Fatalf("replay=%s err=%v", replay, err)
	}
	var view admission.RuntimeProfileView
	if json.Unmarshal([]byte(first), &view) != nil || len(view.Digest) != 64 || view.Spec.Revision != 1 ||
		view.FilesystemBoundary != admission.FilesystemBoundaryName || view.NetworkBoundary != admission.NetworkBoundaryName {
		t.Fatalf("view=%s", first)
	}
	listed, err := invoke("profile", "list")
	if err != nil || !strings.Contains(listed, view.Digest) {
		t.Fatalf("listed=%s err=%v", listed, err)
	}
	for _, pattern := range []string{".probe-workspace-*", ".probe-outside-*"} {
		matches, err := filepath.Glob(filepath.Join(data, "runtime-profile-probes", "*", pattern))
		if err != nil || len(matches) != 0 {
			t.Fatalf("probe residue %s: %v %v", pattern, matches, err)
		}
	}
	owner, err := ownership.Acquire(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := invoke("profile", "list"); err == nil {
		t.Fatal("profile CLI bypassed the running Bridge owner")
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
	if _, err := invoke(register...); err == nil {
		t.Fatal("expired credential registered a profile")
	}
	revoked, err := invoke("profile", "revoke", "--confirm", "--profile-id", view.Spec.ProfileID,
		"--expected-revision", "1", "--expected-digest", view.Digest)
	if err != nil || json.Unmarshal([]byte(revoked), &view) != nil || view.RevokedAt == nil {
		t.Fatalf("revoked=%s err=%v", revoked, err)
	}
	replayed, err := invoke("profile", "revoke", "--confirm", "--profile-id", view.Spec.ProfileID,
		"--expected-revision", "1", "--expected-digest", view.Digest)
	if err != nil || replayed != revoked {
		t.Fatalf("revocation replay=%s err=%v", replayed, err)
	}
	if _, err := os.Stat(filepath.Join(data, "inbox")); !os.IsNotExist(err) {
		t.Fatal("profile administration started Run machinery")
	}
}

func TestRepositoryProfileCLIRejectsPhysicalEscapeWithoutRecord(t *testing.T) {
	_, configPath, data, _ := repositoryProfileFixture(t, "network-escape")
	args := []string{"profile", "register", "--confirm", "--profile-id", "profile_runtime0001",
		"--agent-id", "agent_profile0001", "--permission-profile", "convenewire_governed", "--config", configPath}
	if err := repositoryCommand(args, &bytes.Buffer{}, time.Now); err == nil {
		t.Fatal("network escape registered a Runtime profile")
	}
	entries, err := filepath.Glob(filepath.Join(data, "runtime-profiles", "*", "profile_*.json"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed probe left registration: %v %v", entries, err)
	}
	for _, pattern := range []string{".probe-workspace-*", ".probe-outside-*"} {
		matches, _ := filepath.Glob(filepath.Join(data, "runtime-profile-probes", "*", pattern))
		if len(matches) != 0 {
			t.Fatalf("failed probe left roots: %v", matches)
		}
	}
}

func TestRepositoryProfileCLIResolvesExistingSymlinkedDataDirectory(t *testing.T) {
	root, configPath, data, _ := repositoryProfileFixture(t, "safe")
	linked := filepath.Join(root, "data-link")
	if err := os.Symlink(data, linked); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	loaded, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	loaded.DataDir = linked
	if err := config.Replace(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := repositoryCommand([]string{"profile", "list", "--config", configPath}, &output, time.Now); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(output.String()) != "[]" {
		t.Fatalf("unexpected profile inventory: %s", output.String())
	}
}

func repositoryProfileFixture(t *testing.T, mode string) (string, string, string, pairing.Credential) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data, workspace := filepath.Join(root, "data"), filepath.Join(root, "ordinary-workspace")
	for _, directory := range []string{data, workspace} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	executable := filepath.Join(root, "codex")
	if err := os.Link(os.Args[0], executable); err != nil {
		t.Fatal(err)
	}
	agent := config.AgentConfig{Name: "Builder", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
		PresetVersion: config.CurrentPresetVersion, Command: []string{executable, "-test.run=^TestRepositoryProfileHelperProcess$", "--",
			"app-server", "--listen", "stdio://", "profile-helper=" + mode}, Workspace: workspace, Sandbox: "workspace-write", EnvAllowlist: []string{"HOME"}}
	cfg := config.Config{ServerURL: "http://127.0.0.1:1", DeviceName: "Profile fixture", DataDir: data, Agents: []config.AgentConfig{agent}}
	configPath := filepath.Join(root, "bridge.json")
	if err := config.Save(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	credential := pairing.Credential{ServerURL: cfg.ServerURL, TeamID: "team_profilecli0001", DeviceID: "device_profilecli0001",
		OwnerMemberID: "member_profilecli0001", Token: strings.Repeat("secret", 8)}
	if err := pairing.Save(data, credential); err != nil {
		t.Fatal(err)
	}
	if err := identity.BindName(data, agent.Name, "agent_profile0001"); err != nil {
		t.Fatal(err)
	}
	return root, configPath, data, credential
}

func TestRepositoryProfileHelperProcess(t *testing.T) {
	mode := ""
	for _, argument := range os.Args {
		if strings.HasPrefix(argument, "profile-helper=") {
			mode = strings.TrimPrefix(argument, "profile-helper=")
		}
	}
	if mode == "" {
		return
	}
	reader, writer := bufio.NewScanner(os.Stdin), json.NewEncoder(os.Stdout)
	for reader.Scan() {
		var request struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(reader.Bytes(), &request) != nil || request.ID == 0 {
			continue
		}
		result := any(map[string]any{})
		switch request.Method {
		case "permissionProfile/list":
			result = map[string]any{"data": []map[string]any{{"id": "convenewire_governed", "allowed": true}}, "nextCursor": nil}
		case "config/read":
			result = map[string]any{"config": map[string]any{"permissions": map[string]any{"convenewire_governed": profilePermissionDefinition()}}}
		case "command/exec":
			var params struct {
				Command []string `json:"command"`
				Cwd     string   `json:"cwd"`
			}
			_ = json.Unmarshal(request.Params, &params)
			exit, stdout := 1, ""
			if len(params.Command) > 0 && params.Command[0] == "/usr/bin/nc" {
				if len(params.Command) == 2 && params.Command[1] == "-h" {
					exit = 0
				} else if mode == "network-escape" {
					connection, err := net.DialTimeout("tcp4", net.JoinHostPort(params.Command[len(params.Command)-2], params.Command[len(params.Command)-1]), time.Second)
					if err == nil {
						_ = connection.Close()
						exit = 0
					}
				}
			} else if len(params.Command) > 0 && params.Command[0] == "/bin/sh" {
				target := params.Command[len(params.Command)-1]
				if filepath.Dir(target) == params.Cwd && os.WriteFile(target, []byte("permitted"), 0o600) == nil {
					exit = 0
				}
			}
			result = map[string]any{"exitCode": exit, "stdout": stdout, "stderr": ""}
		}
		_ = writer.Encode(map[string]any{"id": request.ID, "result": result})
	}
}

func profilePermissionDefinition() json.RawMessage {
	value := map[string]any{"description": nil, "extends": nil, "workspace_roots": nil,
		"filesystem": map[string]any{"glob_scan_max_depth": nil, ":root": "deny", ":minimal": "read", ":tmpdir": "deny", ":slash_tmp": "deny", ":workspace_roots": map[string]string{".": "write"}},
		"network":    map[string]any{"enabled": false, "domains": nil}}
	raw, _ := json.Marshal(value)
	return raw
}
