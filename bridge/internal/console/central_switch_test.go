package console

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
)

func centralSwitchInput(previous config.Config, target string) ReDevicePairingInput {
	return ReDevicePairingInput{
		ReEnrollmentInput:  ReEnrollmentInput{ConfirmNewDevice: true, ExpectedDeviceID: "device_original"},
		CentralSwitchInput: CentralSwitchInput{ConfirmCentralSwitch: true, ExpectedServerURL: previous.ServerURL},
		PairingLink: strings.Replace(strings.Replace(recoveryPairingLink,
			url.QueryEscape("http://127.0.0.1:3000"), url.QueryEscape(target), 1),
			"#claimSecret="+strings.Repeat("s", 43), "#claimSecret="+strings.Repeat("c", 43), 1),
	}
}

func switchRequest(t *testing.T, server *httptest.Server, service *Service, input ReDevicePairingInput, status int) {
	t.Helper()
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/device-pairing/restart", input)
	defer response.Body.Close()
	if response.StatusCode != status {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("Central switch: got %d, want %d: %s", response.StatusCode, status, body)
	}
}

func TestCentralSwitchApprovesNewOriginWithoutTransferringSecretsOrHistory(t *testing.T) {
	approved := make(chan struct{})
	// Real anonymous pairing HTTP exchange with a distinct disposable Central.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "" || r.Header.Get(config.ServerTokenHeader) != "" {
			t.Error("old authentication sent to new Central")
		}
		source, _ := io.ReadAll(r.Body)
		for _, secret := range []string{"original-device-secret", strings.Repeat("s", 32), "CUSTOM_PROVIDER_KEY", `"workspace"`, `"agents"`, `"command"`} {
			if bytes.Contains(source, []byte(secret)) {
				t.Error("local configuration leaked in pairing")
			}
		}
		var body map[string]any
		if err := json.Unmarshal(source, &body); err != nil {
			t.Error(err)
			return
		}
		result := map[string]any{"pairingSessionId": "pairing_recovery123", "pairingAttemptId": body["pairingAttemptId"]}
		switch {
		case strings.HasSuffix(r.URL.Path, "/claim"):
			result["state"] = "claimed"
			result["verificationPhrase"] = "VIOLET-RIVER-42"
			result["expiresAt"] = "2099-08-29T12:00:00Z"
			result["pollIntervalMs"] = 500
		case strings.HasSuffix(r.URL.Path, "/poll"):
			select {
			case <-approved:
			case <-r.Context().Done():
				return
			}
			result["state"], result["credentialSource"] = "consumed", "poll_secret"
			// IDs are namespaced by Central; a coincident ID must be legal.
			result["deviceId"], result["teamId"], result["ownerMemberId"] = "device_original", "team_new12345", "member_new12345"
		default:
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}))
	defer target.Close()
	dependencies := inertDependencies()
	dependencies.PairDevice = (pairing.SessionClient{BridgeVersion: "0.4.2"}).Pair
	connected := make(chan config.Config, 1)
	dependencies.RunBridge = func(ctx context.Context, cfg config.Config, credential pairing.Credential, _ operations.Observer) error {
		if credential.ServerURL != target.URL || credential.Token == "original-device-secret" || cfg.ServerToken != "" {
			t.Error("connection reused old credentials")
		}
		connected <- cfg
		<-ctx.Done()
		return ctx.Err()
	}
	service, previous := pairedRecoveryService(t, dependencies)
	defer service.Close()
	before, _ := os.ReadFile(service.options.ConfigPath)
	oldCredential, _ := os.ReadFile(filepath.Join(previous.DataDir, "device-credential.json"))
	oldAgent := service.State().Agents[0].AgentID
	marker := filepath.Join(previous.DataDir, "inbox-marker")
	if err := os.WriteFile(marker, []byte("old history"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	switchRequest(t, server, service, centralSwitchInput(previous, target.URL), http.StatusAccepted)
	pending := waitState(t, service, func(state State) bool { return state.Phase == PhaseApproval })
	if pending.ServerURL != previous.ServerURL || pending.DeviceID != "device_original" || pending.Enrollment.TargetServerURL != target.URL {
		t.Fatal("pending switch replaced the active binding or hid target")
	}
	during, _ := os.ReadFile(service.options.ConfigPath)
	if !bytes.Equal(before, during) {
		t.Fatal("configuration changed before approval")
	}
	if _, err := service.StartBridge(); err == nil {
		t.Fatal("started old Bridge during pairing")
	}
	close(approved)
	state := waitState(t, service, func(state State) bool { return state.ServerURL == target.URL && state.BridgeRunning })
	select {
	case <-connected:
	case <-time.After(time.Second):
		t.Fatal("new Bridge not started")
	}
	current, err := config.Load(service.options.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if current.DataDir == previous.DataDir || current.ServerToken != "" || current.DeviceName != previous.DeviceName || !reflect.DeepEqual(current.Agents, previous.Agents) || state.Agents[0].AgentID == oldAgent {
		t.Fatal("switch failed to isolate identities and preserve local profiles")
	}
	backup, err := config.Load(state.Enrollment.BackupConfigPath)
	if err != nil || !reflect.DeepEqual(backup, previous) {
		t.Fatal("previous configuration backup missing")
	}
	afterCredential, _ := os.ReadFile(filepath.Join(previous.DataDir, "device-credential.json"))
	if !bytes.Equal(oldCredential, afterCredential) {
		t.Fatal("old credentials changed")
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("old history removed")
	}
	if _, err := os.Stat(filepath.Join(current.DataDir, "inbox-marker")); !os.IsNotExist(err) {
		t.Fatal("old history transferred")
	}
	public, _ := json.Marshal(state)
	for _, secret := range []string{"original-device-secret", strings.Repeat("s", 32), "claimSecret"} {
		if bytes.Contains(public, []byte(secret)) {
			t.Fatal("state leaked secrets")
		}
	}
	service.Close()
	reopened, err := New(Options{ConfigPath: service.options.ConfigPath}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if reopened.State().ServerURL != target.URL || !reopened.State().Paired {
		t.Fatal("restart lost selected Central")
	}
}

func TestCentralSwitchCandidateResetsOriginAuthorityOnly(t *testing.T) {
	_, previous := pairedRecoveryService(t, inertDependencies())
	previous.ServerURL = "https://old.example"
	previous.ServerTrustMode = config.TrustPinnedSHA256
	previous.ServerCertificateSHA256 = strings.Repeat("a", 64)
	previous.ShareReasoningSummaries = true
	previous.AgentProvisioning = config.AgentProvisioningConfig{Mode: config.AgentProvisioningRotating, RotatingSecret: "old-secret"}
	candidate, err := pairingCandidate(previous, "https://new.example", CentralSwitchInput{true, previous.ServerURL})
	if err != nil {
		t.Fatal(err)
	}
	if candidate.ServerToken != "" || candidate.ServerCertificateSHA256 != "" || candidate.ResolvedTrustMode() != config.TrustSystemCA || candidate.ShareReasoningSummaries || candidate.AgentProvisioning != (config.AgentProvisioningConfig{}) {
		t.Fatal("candidate retained old-origin authority")
	}
	if !reflect.DeepEqual(candidate.Agents, previous.Agents) {
		t.Fatal("candidate lost profiles")
	}
	same, err := pairingCandidate(previous, previous.ServerURL, CentralSwitchInput{})
	if err != nil || !reflect.DeepEqual(same, previous) {
		t.Fatal("same-Central pairing changed settings")
	}
}

func TestCentralSwitchRejectsImplicitStaleAndBusyRequests(t *testing.T) {
	dependencies := inertDependencies()
	dependencies.PairDevice = func(context.Context, config.Config, pairing.SessionInput, func(pairing.SessionStatus)) (pairing.Credential, error) {
		t.Error("unsafe switch reached pairing")
		return pairing.Credential{}, errors.New("unexpected")
	}
	service, previous := pairedRecoveryService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	input := centralSwitchInput(previous, "https://new.example")
	for _, confirmation := range []CentralSwitchInput{{}, {false, previous.ServerURL}, {true, ""}, {true, "https://stale.example"}} {
		request := input
		request.CentralSwitchInput = confirmation
		switchRequest(t, server, service, request, http.StatusConflict)
	}
	unauthorized := consoleRequest(t, server.URL, "wrong-token", http.MethodPost, "/api/device-pairing/restart", input)
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatal("switch bypassed local authentication")
	}
	for _, fence := range []string{"running", "draining", "preflight", "runtime-test", "run", "enrollment"} {
		service.mu.Lock()
		switch fence {
		case "running":
			service.bridgeCancel = func() {}
		case "draining":
			service.bridgeWorkers = 1
		case "preflight":
			service.runtimePreflight = true
		case "runtime-test":
			service.runtimeTests["test"] = struct{}{}
		case "run":
			service.state.Agents[0].ActiveRuns = 1
		case "enrollment":
			service.joinCancel = func() {}
		}
		service.mu.Unlock()
		switchRequest(t, server, service, input, http.StatusConflict)
		service.mu.Lock()
		service.bridgeCancel, service.joinCancel = nil, nil
		service.bridgeWorkers, service.state.Agents[0].ActiveRuns = 0, 0
		service.runtimePreflight = false
		delete(service.runtimeTests, "test")
		service.mu.Unlock()
	}
	input.ExpectedDeviceID = "device_stale"
	switchRequest(t, server, service, input, http.StatusConflict)
}

func TestCentralSwitchFailureAndCancellationKeepPreviousSelection(t *testing.T) {
	for _, failure := range []string{"approval", "backup", "credential", "activation", "wrong-origin", "disk-change", "credential-change", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			service, previous := pairedRecoveryService(t, inertDependencies())
			before, _ := os.ReadFile(service.options.ConfigPath)
			oldAgent := service.State().Agents[0].AgentID
			candidate, err := pairingCandidate(previous, "https://new.example", CentralSwitchInput{true, previous.ServerURL})
			if err != nil {
				t.Fatal(err)
			}
			service.mu.Lock()
			ctx, epoch := service.beginEnrollmentLocked(true)
			service.state.Enrollment.TargetServerURL = candidate.ServerURL
			service.mu.Unlock()
			credential := approvedRecoveryCredential(candidate)
			var pairingError error
			switch failure {
			case "approval":
				pairingError = errors.New("pairing denied")
			case "backup":
				service.dependencies.SaveConfig = func(string, config.Config) error { return errors.New("secret") }
			case "credential":
				service.dependencies.SaveCredential = func(string, pairing.Credential) error { return errors.New("secret") }
			case "activation":
				service.dependencies.ReplaceConfig = func(string, config.Config) error { return errors.New("secret") }
			case "wrong-origin":
				credential.ServerURL = previous.ServerURL
			case "disk-change":
				changed := previous
				changed.DeviceName = "External edit"
				if err := config.Replace(service.options.ConfigPath, changed); err != nil {
					t.Fatal(err)
				}
				before, _ = os.ReadFile(service.options.ConfigPath)
			case "credential-change":
				original, _ := pairing.Load(previous.DataDir)
				changed := original
				changed.Token = "externally-changed-token"
				if err := pairing.Replace(previous.DataDir, original, changed); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				service.cancelEnrollment(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/enrollment/cancel", nil))
			}
			// Includes approval arriving after cancellation: it must never install.
			service.finishEnrollment(ctx, candidate, credential, pairingError, true, true, epoch)
			state := service.State()
			if state.ServerURL != previous.ServerURL || state.DeviceID != "device_original" || state.Agents[0].AgentID != oldAgent || state.BridgeRunning || state.Enrollment.Active || state.Enrollment.TargetServerURL != "" {
				t.Fatal("unsuccessful switch changed active binding or left approval target")
			}
			after, _ := os.ReadFile(service.options.ConfigPath)
			if !bytes.Equal(before, after) {
				t.Fatal("unsuccessful switch overwrote configuration")
			}
			service.Close()
			reopened, err := New(Options{ConfigPath: service.options.ConfigPath}, inertDependencies())
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if reopened.State().ServerURL != previous.ServerURL {
				t.Fatal("restart selected failed candidate")
			}
		})
	}
}

func TestCentralSwitchConfiguredUnpairedRequiresApprovalAndFreshSelection(t *testing.T) {
	dependencies := inertDependencies()
	approve := make(chan struct{})
	dependencies.PairDevice = func(ctx context.Context, cfg config.Config, _ pairing.SessionInput, show func(pairing.SessionStatus)) (pairing.Credential, error) {
		show(pairing.SessionStatus{State: "claimed", VerificationPhrase: "VIOLET-RIVER-42"})
		select {
		case <-approve:
			return approvedRecoveryCredential(cfg), nil
		case <-ctx.Done():
			return pairing.Credential{}, ctx.Err()
		}
	}
	service, previous := pairedRecoveryService(t, dependencies)
	// Model a saved configuration whose initial pairing was never completed.
	if err := os.Remove(filepath.Join(previous.DataDir, "device-credential.json")); err != nil {
		t.Fatal(err)
	}
	service.mu.Lock()
	service.credential = nil
	service.state.Paired = false
	service.state.DeviceID, service.state.TeamID = "", ""
	service.mu.Unlock()
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	input := centralSwitchInput(previous, "https://new.example")
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/device-pairing/start", DevicePairingInput{
		CentralSwitchInput: input.CentralSwitchInput, PairingLink: input.PairingLink,
	})
	response.Body.Close()
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("unpaired switch rejected: %d", response.StatusCode)
	}
	waitState(t, service, func(state State) bool { return state.Phase == PhaseApproval })
	if service.State().ServerURL != previous.ServerURL {
		t.Fatal("unpaired switch committed before approval")
	}
	close(approve)
	state := waitState(t, service, func(state State) bool { return state.Paired && state.ServerURL == "https://new.example" })
	current, _ := config.Load(service.options.ConfigPath)
	if current.DataDir == previous.DataDir || !reflect.DeepEqual(current.Agents, previous.Agents) || state.Enrollment.BackupConfigPath == "" {
		t.Fatal("unpaired switch lost isolated commit")
	}
}
