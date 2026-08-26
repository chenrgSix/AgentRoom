package console

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
)

func pairedRecoveryService(t *testing.T, dependencies Dependencies) (*Service, config.Config) {
	t.Helper()
	directory := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configuration := config.Config{
		SchemaVersion: config.CurrentSchemaVersion, ServerURL: "http://127.0.0.1:3000",
		ServerToken: strings.Repeat("s", 32), DeviceName: "Recovery Bridge",
		DataDir: filepath.Join(directory, "data"),
		Agents: []config.AgentConfig{{
			Name: "Codex", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
			PresetVersion: config.CurrentPresetVersion, Sandbox: "workspace-write",
			Command: config.CodexPresetCommand(executable), Workspace: directory,
			EnvAllowlist: []string{"HOME", "PATH", "CODEX_HOME"},
		}, {
			Name: "Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi",
			PresetVersion: config.CurrentPresetVersion,
			Command:       config.PiPresetCommand(executable, "--tools", "read,grep"), Workspace: directory,
			EnvAllowlist: []string{"HOME", "PATH", "CUSTOM_PROVIDER_KEY"},
		}},
	}
	configPath := filepath.Join(directory, "bridge.json")
	if err := config.Save(configPath, configuration); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(configuration.DataDir, pairing.Credential{
		ServerURL: configuration.ServerURL, DeviceID: "device_original", TeamID: "team_original",
		OwnerMemberID: "member_original", Token: "original-device-secret",
	}); err != nil {
		t.Fatal(err)
	}
	service, err := New(Options{ConfigPath: configPath, Token: "recovery-console-token"}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return service, *service.configuration
}

func approvedRecoveryCredential(configuration config.Config) pairing.Credential {
	return pairing.Credential{
		ServerURL: configuration.ServerURL, DeviceID: "device_replacement", TeamID: "team_replacement",
		OwnerMemberID: "member_replacement", Token: "replacement-device-secret",
	}
}

func recoveryRequest(t *testing.T, serverURL string, service *Service, expectedStatus int) {
	t.Helper()
	response := consoleRequest(t, serverURL, service.Token(), http.MethodPost, "/api/enrollment/restart", ReEnrollmentInput{
		ConfirmNewDevice: true, ExpectedDeviceID: "device_original",
	})
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("unexpected recovery status: %d %s", response.StatusCode, body)
	}
}

func TestReEnrollmentPreservesOldDataAndAtomicallySelectsFreshIdentity(t *testing.T) {
	approved := make(chan struct{})
	dependencies := inertDependencies()
	dependencies.Enroll = func(ctx context.Context, cfg config.Config, show func(enrollment.Challenge)) (pairing.Credential, error) {
		show(enrollment.Challenge{UserCode: "ABCD-1234", ExpiresAt: time.Now().Add(time.Minute)})
		select {
		case <-approved:
			return approvedRecoveryCredential(cfg), nil
		case <-ctx.Done():
			return pairing.Credential{}, ctx.Err()
		}
	}
	service, previous := pairedRecoveryService(t, dependencies)
	oldAgentID := service.State().Agents[0].AgentID
	oldConfig, _ := os.ReadFile(service.options.ConfigPath)
	oldCredential, _ := os.ReadFile(filepath.Join(previous.DataDir, "device-credential.json"))
	marker := filepath.Join(previous.DataDir, "inbox")
	if err := os.Mkdir(marker, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(marker, "old-run.json"), []byte("retained old Run evidence"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	recoveryRequest(t, server.URL, service, http.StatusAccepted)
	waitState(t, service, func(state State) bool { return state.JoinCode == "ABCD-1234" })
	whileWaiting, _ := os.ReadFile(service.options.ConfigPath)
	if !bytes.Equal(whileWaiting, oldConfig) || service.State().DeviceID != "device_original" {
		t.Fatal("requesting an approval code changed the active identity")
	}
	close(approved)
	state := waitState(t, service, func(state State) bool { return state.BridgeRunning && state.DeviceID == "device_replacement" })
	if state.Agents[0].AgentID == oldAgentID || state.JoinCode != "" || state.JoinExpiresAt != "" || state.Enrollment.Active {
		t.Fatalf("old identity or code survived enrollment: %#v", state)
	}
	current, err := config.Load(service.options.ConfigPath)
	if err != nil || current.DataDir == previous.DataDir || !reflect.DeepEqual(current.Agents, previous.Agents) || current.ServerToken != previous.ServerToken {
		t.Fatalf("configuration was not preserved in a fresh identity: %v", err)
	}
	for _, path := range []string{"inbox", "connection-epoch", "sessions"} {
		if _, err := os.Stat(filepath.Join(current.DataDir, path)); !os.IsNotExist(err) {
			t.Fatalf("new pairing inherited old state %s: %v", path, err)
		}
	}
	retained, _ := os.ReadFile(filepath.Join(previous.DataDir, "device-credential.json"))
	if !bytes.Equal(retained, oldCredential) {
		t.Fatal("old credential changed")
	}
	if _, err := os.Stat(filepath.Join(marker, "old-run.json")); err != nil {
		t.Fatal("old inbox was removed")
	}
	backup, err := config.Load(state.Enrollment.BackupConfigPath)
	if err != nil || !reflect.DeepEqual(backup, previous) {
		t.Fatalf("old configuration backup is incomplete: %v", err)
	}
	for _, path := range []string{current.DataDir, state.Enrollment.BackupConfigPath, filepath.Join(current.DataDir, "device-credential.json"), filepath.Join(current.DataDir, "agent-identities.json")} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("pairing state is not owner-only: %s, %v", path, err)
		}
	}
	for _, item := range []struct{ path, device string }{{service.options.ConfigPath, "device_replacement"}, {state.Enrollment.BackupConfigPath, "device_original"}} {
		reopened, err := New(Options{ConfigPath: item.path}, inertDependencies())
		if err != nil {
			t.Fatal(err)
		}
		if reopened.State().DeviceID != item.device {
			t.Fatal("reopening selected the wrong identity")
		}
		reopened.Close()
	}
	serialized, _ := json.Marshal(state)
	for _, forbidden := range []string{previous.ServerToken, "original-device-secret", "replacement-device-secret", service.Token()} {
		if bytes.Contains(serialized, []byte(forbidden)) {
			t.Fatal("public pairing state leaked a credential")
		}
	}
	// The legacy whole-config editor must also retain the selected generation.
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/config", EnrollmentInput{
		ServerURL: current.ServerURL, DeviceName: current.DeviceName,
		Runtimes: []RuntimeInput{{Kind: "codex", Enabled: true, Name: "Codex", Role: "Builder",
			ExecutablePath: current.Agents[0].Command[0], Workspace: current.Agents[0].Workspace}},
	})
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("legacy configuration update failed: %d", response.StatusCode)
	}
	edited, err := config.Load(service.options.ConfigPath)
	if err != nil || edited.DataDir != current.DataDir {
		t.Fatal("legacy configuration update restored the wrong pairing generation")
	}
}

func TestReEnrollmentRequiresConfirmationAndIdleDrainedBridge(t *testing.T) {
	exit := make(chan struct{})
	dependencies := inertDependencies()
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, _ operations.Observer) error {
		<-ctx.Done()
		<-exit
		return nil
	}
	service, _ := pairedRecoveryService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	for _, input := range []struct {
		token string
		body  ReEnrollmentInput
		code  int
	}{
		{"wrong", ReEnrollmentInput{true, "device_original"}, http.StatusUnauthorized},
		{service.Token(), ReEnrollmentInput{false, "device_original"}, http.StatusBadRequest},
		{service.Token(), ReEnrollmentInput{true, "device_other"}, http.StatusConflict},
	} {
		response := consoleRequest(t, server.URL, input.token, http.MethodPost, "/api/enrollment/restart", input.body)
		response.Body.Close()
		if response.StatusCode != input.code {
			t.Fatalf("unsafe recovery accepted: %d", response.StatusCode)
		}
	}
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/enrollment/start", nil)
	response.Body.Close()
	if response.StatusCode != http.StatusConflict {
		t.Fatal("ordinary enrollment replaced an existing credential without confirmation")
	}
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	recoveryRequest(t, server.URL, service, http.StatusConflict)
	service.StopBridge()
	recoveryRequest(t, server.URL, service, http.StatusConflict)
	if service.State().Enrollment.CanRequest {
		t.Fatal("undrained connection was advertised as safe for re-enrollment")
	}
	close(exit)
	waitState(t, service, func(state State) bool { return state.Enrollment.CanRequest })
	for _, fence := range []string{"preflight", "test", "run"} {
		service.mu.Lock()
		service.runtimePreflight = fence == "preflight"
		service.runtimeTests = make(map[string]struct{})
		if fence == "test" {
			service.runtimeTests["Codex"] = struct{}{}
		}
		service.state.Agents[0].ActiveRuns = 0
		if fence == "run" {
			service.state.Agents[0].ActiveRuns = 1
		}
		service.mu.Unlock()
		recoveryRequest(t, server.URL, service, http.StatusConflict)
	}
}

func TestCanceledEnrollmentCannotPublishLateCodeOrSaveLateCredential(t *testing.T) {
	dependencies := inertDependencies()
	dependencies.Enroll = func(_ context.Context, cfg config.Config, show func(enrollment.Challenge)) (pairing.Credential, error) {
		show(enrollment.Challenge{UserCode: "LATE-CODE", ExpiresAt: time.Now().Add(time.Minute)})
		return approvedRecoveryCredential(cfg), nil
	}
	service, previous := pairedRecoveryService(t, dependencies)
	service.mu.Lock()
	oldContext, oldEpoch := service.beginEnrollmentLocked(true)
	service.mu.Unlock()
	response := httptest.NewRecorder()
	service.cancelEnrollment(response, httptest.NewRequest(http.MethodPost, "/api/enrollment/cancel", nil))
	service.mu.Lock()
	_, currentEpoch := service.beginEnrollmentLocked(true)
	service.state.Phase = PhaseApproval
	service.state.JoinCode = "LIVE-CODE"
	service.state.JoinExpiresAt = time.Now().Add(time.Minute).Format(time.RFC3339Nano)
	service.mu.Unlock()
	// Complete the old attempt synchronously after a new attempt exists.
	service.enroll(oldContext, previous, true, true, oldEpoch)
	state := service.State()
	if state.JoinCode != "LIVE-CODE" || !state.Enrollment.Active || service.joinEpoch != currentEpoch || state.DeviceID != "device_original" {
		t.Fatalf("late canceled enrollment corrupted the current attempt: %#v", state)
	}
	if _, err := service.StartBridge(); err == nil {
		t.Fatal("Bridge started while waiting for enrollment")
	}
	service.dependencies.ProbeRuntime = func(context.Context, config.AgentConfig) RuntimeProbeResult {
		t.Error("Runtime probe started during enrollment")
		return RuntimeProbeResult{}
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	probe := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-tests", map[string]string{"agentId": state.Agents[0].AgentID})
	probe.Body.Close()
	if probe.StatusCode != http.StatusConflict {
		t.Fatal("Runtime probe was not fenced by pending enrollment")
	}
	service.StopBridge()
	if service.State().Phase != PhaseApproval {
		t.Fatal("tray Stop hid the pending approval code")
	}
	current, _ := config.Load(service.options.ConfigPath)
	if current.DataDir != previous.DataDir {
		t.Fatal("canceled attempt wrote a new binding")
	}
	service.mu.Lock()
	service.state.JoinExpiresAt = time.Now().Add(-time.Second).Format(time.RFC3339Nano)
	service.mu.Unlock()
	expired := service.State()
	if !expired.Enrollment.CodeExpired || expired.JoinCode != "" {
		t.Fatal("expired approval code remained usable in state")
	}
}

func TestReEnrollmentStagingFailuresKeepPreviousPairing(t *testing.T) {
	for _, stage := range []string{"backup", "credential", "identity", "activation", "disk-change", "incomplete-identity"} {
		t.Run(stage, func(t *testing.T) {
			service, previous := pairedRecoveryService(t, inertDependencies())
			before, _ := os.ReadFile(service.options.ConfigPath)
			credentialBefore, _ := os.ReadFile(filepath.Join(previous.DataDir, "device-credential.json"))
			originalID := service.State().Agents[0].AgentID
			service.dependencies.Enroll = func(_ context.Context, cfg config.Config, _ func(enrollment.Challenge)) (pairing.Credential, error) {
				credential := approvedRecoveryCredential(cfg)
				if stage == "incomplete-identity" {
					credential.TeamID = ""
				}
				if stage == "disk-change" {
					cfg.DeviceName = "Externally changed"
					if err := config.Replace(service.options.ConfigPath, cfg); err != nil {
						t.Error(err)
					}
				}
				return credential, nil
			}
			if stage == "backup" {
				service.dependencies.SaveConfig = func(string, config.Config) error { return errors.New("seeded-secret") }
			}
			if stage == "credential" {
				service.dependencies.SaveCredential = func(string, pairing.Credential) error { return errors.New("seeded-secret") }
			}
			if stage == "identity" {
				service.dependencies.SaveCredential = func(directory string, credential pairing.Credential) error {
					if err := pairing.Save(directory, credential); err != nil {
						return err
					}
					return os.Mkdir(filepath.Join(directory, "agent-identities.json"), 0o700)
				}
			}
			if stage == "activation" {
				service.dependencies.ReplaceConfig = func(string, config.Config) error { return errors.New("seeded-secret") }
			}
			server := httptest.NewServer(service.Handler())
			defer server.Close()
			recoveryRequest(t, server.URL, service, http.StatusAccepted)
			state := waitState(t, service, func(state State) bool { return state.Phase == PhaseError })
			if state.DeviceID != "device_original" || state.Agents[0].AgentID != originalID || state.BridgeRunning || strings.Contains(state.LastError, "seeded-secret") {
				t.Fatalf("staging failure damaged the old binding: %#v", state)
			}
			after, _ := os.ReadFile(service.options.ConfigPath)
			if stage != "disk-change" && !bytes.Equal(before, after) {
				t.Fatal("failed enrollment changed the active config")
			}
			if stage == "disk-change" {
				current, _ := config.Load(service.options.ConfigPath)
				if current.DeviceName != "Externally changed" {
					t.Fatal("enrollment overwrote an external config edit")
				}
			}
			credentialAfter, _ := os.ReadFile(filepath.Join(previous.DataDir, "device-credential.json"))
			if !bytes.Equal(credentialBefore, credentialAfter) {
				t.Fatal("failed enrollment changed the old credential")
			}
			reopened, err := New(Options{ConfigPath: service.options.ConfigPath}, inertDependencies())
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if reopened.State().DeviceID != "device_original" {
				t.Fatal("restart selected a partially staged identity")
			}
		})
	}
}
