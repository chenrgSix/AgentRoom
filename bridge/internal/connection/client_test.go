package connection

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/buildidentity"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
	contracts "convenewire.dev/contracts/generated/go"
	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
	"github.com/coder/websocket"
)

func contractRunRequest(runID, traceID, targetAgentID string) contracts.RunRequestedMessage {
	return contracts.RunRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_" + strings.TrimPrefix(runID, "run_"),
		Timestamp:       time.Now().UTC(),
		Type:            contracts.RunRequested,
		Payload: contracts.RunRequestedPayload{
			RunID:             runID,
			TraceID:           traceID,
			RoomID:            "room_contract_fixture_12345678",
			TriggerMessageID:  "msg_contract_trigger_12345678",
			RequesterMemberID: "member_contract_fixture_12345678",
			TargetAgentID:     targetAgentID,
			DeliveryAttemptID: "delivery_contract_fixture_12345678",
			IdempotencyKey:    "contract-fixture-idempotency-key",
			Instruction:       "Exercise the Bridge connection boundary.",
			ContextMessages:   []contracts.ContextMessage{},
			Deadline:          time.Now().UTC().Add(time.Minute),
		},
	}
}

func TestClientRejectsCrossOriginCredentialBeforeAnyRequest(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()
	client := Client{
		Config: config.Config{ServerURL: server.URL, DataDir: t.TempDir()},
		Credential: pairing.Credential{
			ServerURL: "http://127.0.0.1:1", DeviceID: "device_test", Token: "device-secret",
		},
	}
	if _, err := client.connectOnce(context.Background()); err == nil {
		t.Fatal("cross-origin Device credential was accepted")
	}
	if requests.Load() != 0 {
		t.Fatal("Device credential reached a different Central origin")
	}
}

func TestClientAuthenticatesAndSendsHelloAndHeartbeat(t *testing.T) {
	serverToken := "central-server-token-12345678901234567890"
	messages := make(chan map[string]any, 3)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer device-secret" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
			return
		}
		if request.Header.Get(config.ServerTokenHeader) != serverToken {
			http.Error(response, "missing central Server Token", http.StatusUnauthorized)
			return
		}
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 3; index++ {
			_, source, err := socket.Read(request.Context())
			if err != nil {
				return
			}
			var message map[string]any
			if err := json.Unmarshal(source, &message); err != nil {
				t.Error(err)
				return
			}
			messages <- message
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	directory := t.TempDir()
	client := Client{
		Config: config.Config{
			ServerURL:   server.URL,
			ServerToken: serverToken,
			DataDir:     directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory, WorkspaceAlias: "Payments API",
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		BridgeVersion: "v0.4.0-qa030.2",
		BuildObservation: buildidentity.Observation{
			SourceCommit:     strings.Repeat("a", 40),
			ExecutableSHA256: strings.Repeat("b", 64),
		},
		HeartbeatInterval: 10 * time.Millisecond,
		HandleProvision: func(_ context.Context, requested contracts.AgentProvisionRequestedMessage) contracts.AgentProvisionResultMessage {
			return ProvisionResult(requested, contracts.Rejected, contracts.ProvisioningDisabled)
		},
		ResumeAgentNames:                  map[string]bool{"Builder": true},
		StreamingAgentNames:               map[string]bool{"Builder": true},
		ArtifactMaterializationAgentNames: map[string]bool{"Builder": true},
	}
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	hello := <-messages
	publication := <-messages
	heartbeat := <-messages
	if hello["type"] != "bridge.hello" || publication["type"] != "agent.publish" || heartbeat["type"] != "bridge.heartbeat" {
		t.Fatalf("unexpected messages: %#v %#v %#v", hello, publication, heartbeat)
	}
	helloPayload, ok := hello["payload"].(map[string]any)
	if !ok || helloPayload["supportsAgentProvisioning"] != true {
		t.Fatalf("Agent provisioning support was not advertised: %#v", hello)
	}
	if helloPayload["bridgeVersion"] != "0.4.0-qa030.2" {
		t.Fatalf("Bridge version was not canonicalized: %#v", hello)
	}
	if helloPayload["sourceCommit"] != strings.Repeat("a", 40) ||
		helloPayload["executableSha256"] != strings.Repeat("b", 64) {
		t.Fatalf("Bridge executable identity was not published as one pair: %#v", hello)
	}
	payload, ok := publication["payload"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected publication payload: %#v", publication)
	}
	capabilities, ok := payload["capabilities"].(map[string]any)
	if !ok || capabilities["supportsStreaming"] != true || capabilities["supportsResume"] != true {
		t.Fatalf("Runtime capabilities were not published: %#v", publication)
	}
	if capabilities["supportsWorkspaceLeases"] != true {
		t.Fatalf("Workspace lease capability was not published: %#v", publication)
	}
	if capabilities["supportsArtifactPublication"] != true {
		t.Fatalf("Artifact publication capability was not published: %#v", publication)
	}
	if capabilities["supportsArtifactMaterialization"] != true {
		t.Fatalf("Artifact materialization capability was not published: %#v", publication)
	}
	runtimePolicy, ok := payload["runtimePolicy"].(map[string]any)
	if !ok || len(runtimePolicy) != 1 || runtimePolicy["filesystemAccess"] != "local-policy" {
		t.Fatalf("safe Runtime policy summary was not published: %#v", publication)
	}
	runtimeScopeID, ok := payload["runtimeScopeId"].(string)
	if !ok || len(runtimeScopeID) != 64 {
		t.Fatalf("Runtime scope was not published: %#v", publication)
	}
	workspaceRef, workspaceRefOK := payload["workspaceRef"].(string)
	workspaceGeneration, generationOK := payload["workspaceGeneration"].(string)
	if !workspaceRefOK || !strings.HasPrefix(workspaceRef, "workspace_") ||
		!generationOK || len(workspaceGeneration) != 64 ||
		strings.Contains(workspaceRef, directory) || strings.Contains(workspaceGeneration, directory) {
		t.Fatalf("opaque Workspace snapshot was not published safely: %#v", publication)
	}
	if payload["workspaceAlias"] != "Payments API" {
		t.Fatalf("safe Workspace alias was not published: %#v", publication)
	}
	for _, localField := range []string{
		"workspace", "workspacePath", "workspaceRoot", "filesystemPolicy",
		"networkPolicy", "command", "runtimeCommand", "env", "environment",
	} {
		if _, exists := payload[localField]; exists {
			t.Fatalf("local Workspace detail %q crossed the Bridge boundary: %#v", localField, publication)
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
}

func TestClientRejectsPartialBuildObservationBeforeNetwork(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()
	client := Client{
		Config: config.Config{ServerURL: server.URL, DataDir: t.TempDir()},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", Token: "device-secret",
		},
		BuildObservation: buildidentity.Observation{
			SourceCommit: strings.Repeat("a", 40),
		},
	}
	if _, err := client.connectOnce(context.Background()); err == nil {
		t.Fatal("partial Bridge build observation was accepted")
	}
	if requests.Load() != 0 {
		t.Fatal("partial Bridge build observation reached the network boundary")
	}
}

func TestPublishedRuntimePolicyContainsOnlyFilesystemAccess(t *testing.T) {
	tests := []struct {
		name     string
		agent    config.AgentConfig
		expected contracts.RuntimePolicyFilesystemAccess
	}{
		{name: "Codex read only", agent: config.AgentConfig{RuntimeKind: "codex", Sandbox: "read-only"}, expected: contracts.RuntimePolicyFilesystemAccess("read-only")},
		{name: "Codex Workspace write", agent: config.AgentConfig{RuntimeKind: "codex", Sandbox: "workspace-write"}, expected: contracts.RuntimePolicyFilesystemAccess("workspace-write")},
		{name: "legacy Codex", agent: config.AgentConfig{Adapter: "codex"}, expected: contracts.RuntimePolicyFilesystemAccess("workspace-write")},
		{name: "Pi local policy", agent: config.AgentConfig{RuntimeKind: "pi"}, expected: contracts.RuntimePolicyFilesystemAccess("local-policy")},
		{name: "Generic local policy", agent: config.AgentConfig{RuntimeKind: "generic"}, expected: contracts.RuntimePolicyFilesystemAccess("local-policy")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			policy := publishedRuntimePolicy(test.agent)
			if policy.FilesystemAccess != test.expected {
				t.Fatalf("expected %q, got %q", test.expected, policy.FilesystemAccess)
			}
		})
	}
}

func TestAcceptedProvisioningResultStopsOldConfigurationForReload(t *testing.T) {
	result := make(chan contracts.AgentProvisionResultMessage, 1)
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connections.Add(1)
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		requested := contracts.AgentProvisionRequestedMessage{
			ProtocolVersion: "1.0", MessageID: "msg_provision_request_12345678",
			Timestamp: time.Now().UTC(), Type: contracts.AgentProvisionRequested,
			Payload: contracts.AgentProvisionRequestedPayload{
				RequestID: "agentprov_request_12345678", DeviceID: "device_test_12345678",
				TemplateAgentID: "agent_template_12345678", AgentID: "agent_created_12345678",
				Name: "Reviewer", Role: "Review", ManagementCode: "12345678",
			},
		}
		source, _ := json.Marshal(requested)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		_, source, err = socket.Read(request.Context())
		if err != nil {
			return
		}
		var received contracts.AgentProvisionResultMessage
		if err := json.Unmarshal(source, &received); err != nil {
			t.Error(err)
			return
		}
		result <- received
	}))
	defer server.Close()
	directory := t.TempDir()
	client := Client{
		Config: config.Config{ServerURL: server.URL, DataDir: directory, Agents: []config.AgentConfig{{
			Name: "Builder", Role: "Implementation", Adapter: "generic",
			Command: []string{"agent"}, Workspace: directory,
		}}},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test_12345678", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		HandleProvision: func(_ context.Context, requested contracts.AgentProvisionRequestedMessage) contracts.AgentProvisionResultMessage {
			return ProvisionResult(requested, contracts.Accepted, "")
		},
	}
	done := make(chan error, 1)
	go func() { done <- client.Run(context.Background()) }()
	select {
	case received := <-result:
		if received.Payload.Status != contracts.Accepted || received.Payload.Reason != nil {
			t.Fatalf("unexpected accepted result: %#v", received)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Bridge did not return an Agent provisioning result")
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrConfigurationChanged) {
			t.Fatalf("Bridge did not stop for configuration reload: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge retained the stale configuration after acceptance")
	}
	if connections.Load() != 1 {
		t.Fatalf("stale Client reconnected %d times", connections.Load())
	}
}

func TestProvisioningIsRejectedAsBusyWhileARunIsActive(t *testing.T) {
	result := make(chan contracts.AgentProvisionResultMessage, 1)
	runStarted := make(chan struct{})
	releaseRun := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		run := contractRunRequest(
			"run_active_12345678",
			"trace_active_12345678",
			"agent_template_12345678",
		)
		source, _ := json.Marshal(run)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		select {
		case <-runStarted:
		case <-request.Context().Done():
			return
		}
		requested := contracts.AgentProvisionRequestedMessage{
			ProtocolVersion: "1.0", MessageID: "msg_provision_busy_12345678",
			Timestamp: time.Now().UTC(), Type: contracts.AgentProvisionRequested,
			Payload: contracts.AgentProvisionRequestedPayload{
				RequestID: "agentprov_busy_12345678", DeviceID: "device_test_12345678",
				TemplateAgentID: "agent_template_12345678", AgentID: "agent_created_12345678",
				Name: "Reviewer", Role: "Review", ManagementCode: "12345678",
			},
		}
		source, _ = json.Marshal(requested)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		_, source, err = socket.Read(request.Context())
		if err != nil {
			return
		}
		var received contracts.AgentProvisionResultMessage
		if err := json.Unmarshal(source, &received); err != nil {
			t.Error(err)
			return
		}
		result <- received
		<-request.Context().Done()
	}))
	defer server.Close()
	directory := t.TempDir()
	var provisionCalls atomic.Int32
	client := Client{
		Config: config.Config{ServerURL: server.URL, DataDir: directory, Agents: []config.AgentConfig{{
			Name: "Builder", Role: "Implementation", Adapter: "generic",
			Command: []string{"agent"}, Workspace: directory,
		}}},
		Credential: pairing.Credential{ServerURL: server.URL, DeviceID: "device_test_12345678", Token: "device-secret"},
		HandleRun: func(context.Context, contracts.RunRequestedMessage, func(context.Context, any) error) error {
			close(runStarted)
			<-releaseRun
			return nil
		},
		HandleProvision: func(_ context.Context, requested contracts.AgentProvisionRequestedMessage) contracts.AgentProvisionResultMessage {
			provisionCalls.Add(1)
			return ProvisionResult(requested, contracts.Accepted, "")
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	select {
	case received := <-result:
		if received.Payload.Status != contracts.Rejected || received.Payload.Reason == nil || *received.Payload.Reason != contracts.ReasonBusy {
			t.Fatalf("active Run did not reject provisioning as busy: %#v", received)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Bridge did not reject provisioning during an active Run")
	}
	if provisionCalls.Load() != 0 {
		t.Fatal("busy provisioning reached the local mutation handler")
	}
	close(releaseRun)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestClientStopWaitsForCanceledRunWorkers(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		message, _ := json.Marshal(contractRunRequest(
			"run_draining", "trace_draining", "agent_draining",
		))
		if err := socket.Write(request.Context(), websocket.MessageText, message); err != nil {
			return
		}
		_, _, _ = socket.Read(request.Context())
	}))
	defer server.Close()
	started, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	directory := t.TempDir()
	client := Client{
		Config: config.Config{ServerURL: server.URL, DataDir: directory, Agents: []config.AgentConfig{{
			Name: "Builder", Role: "Implementation", Adapter: "generic", Command: []string{"agent"}, Workspace: directory,
		}}},
		Credential: pairing.Credential{ServerURL: server.URL, DeviceID: "device_draining", TeamID: "team_draining", OwnerMemberID: "member_draining", Token: "fake-secret"},
		HandleRun: func(ctx context.Context, _ contracts.RunRequestedMessage, _ func(context.Context, any) error) error {
			close(started)
			<-ctx.Done()
			close(canceled)
			<-release
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("Run worker did not start")
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("Run worker did not receive cancellation")
	}
	select {
	case <-done:
		close(release)
		t.Fatal("Bridge stopped before its Runtime worker drained")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge did not stop after its Runtime worker exited")
	}
}

func TestClientAcceptsContractValidRunAboveWebSocketLibraryDefault(t *testing.T) {
	accepted := make(chan contracts.RunAcceptedMessage, 1)
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connections.Add(1)
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		requested := contracts.RunRequestedMessage{
			ProtocolVersion: "1.0", MessageID: "msg_large_run_requested",
			Timestamp: time.Now().UTC(), Type: contracts.RunRequested,
			Payload: contracts.RunRequestedPayload{
				RunID: "run_large_request", TraceID: "trace_large_request",
				RoomID: "room_large_request", TriggerMessageID: "msg_large_trigger",
				RequesterMemberID: "member_large_request", TargetAgentID: "agent_large_request",
				DeliveryAttemptID: "delivery_large_request",
				IdempotencyKey:    "large-request-idempotency-key",
				Instruction:       "Review the accumulated discussion context.",
				ContextMessages: []contracts.ContextMessage{{
					MessageID: "msg_large_context", SenderID: "member_large_request",
					Content: strings.Repeat("中", 12_000),
				}},
				Deadline: time.Now().UTC().Add(time.Minute),
			},
		}
		source, err := json.Marshal(requested)
		if err != nil {
			t.Error(err)
			return
		}
		if len(source) <= 32<<10 {
			t.Errorf("large Run fixture is only %d bytes", len(source))
			return
		}
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		_, source, err = socket.Read(request.Context())
		if err != nil {
			return
		}
		var message contracts.RunAcceptedMessage
		if err := json.Unmarshal(source, &message); err != nil {
			t.Error(err)
			return
		}
		accepted <- message
		// Service the client's close handshake so shutdown is synchronized with
		// the WebSocket protocol instead of the HTTP request-context scheduler.
		_, _, _ = socket.Read(request.Context())
	}))
	defer server.Close()

	directory := t.TempDir()
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		HeartbeatInterval: time.Second,
		HandleRun: func(ctx context.Context, requested contracts.RunRequestedMessage, send func(context.Context, any) error) error {
			return send(ctx, contracts.RunAcceptedMessage{
				ProtocolVersion: "1.0", MessageID: "msg_large_run_accepted",
				Timestamp: time.Now().UTC(), Type: contracts.RunAccepted,
				Payload: contracts.RunAcceptedPayload{
					AgentID: requested.Payload.TargetAgentID, RunID: requested.Payload.RunID,
					TraceID: requested.Payload.TraceID, Sequence: 1,
				},
			})
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	select {
	case message := <-accepted:
		if message.Payload.RunID != "run_large_request" {
			t.Fatalf("accepted unexpected Run: %#v", message)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Bridge did not accept the Run above the WebSocket library default")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
	if connections.Load() != 1 {
		t.Fatalf("large Run forced %d WebSocket connections", connections.Load())
	}
}

func TestClientRejectsMessageAboveExplicitTransportLimit(t *testing.T) {
	events := make(chan operations.ConnectionEvent, 16)
	var connections atomic.Int32
	var handled atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connection := connections.Add(1)
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		if connection != 1 {
			<-request.Context().Done()
			return
		}
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		source := []byte(`{"type":"oversized.test","padding":"` +
			strings.Repeat("x", int(maxBridgeIncomingMessageBytes)) + `"}`)
		_ = socket.Write(request.Context(), websocket.MessageText, source)
		<-request.Context().Done()
	}))
	defer server.Close()

	directory := t.TempDir()
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		RetryInitial: time.Millisecond,
		RetryMaximum: time.Millisecond,
		Observer: operations.Observer{OnConnection: func(event operations.ConnectionEvent) {
			events <- event
		}},
		HandleRun: func(context.Context, contracts.RunRequestedMessage, func(context.Context, any) error) error {
			handled.Add(1)
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case event := <-events:
			if event.State != operations.ConnectionRetrying ||
				!strings.Contains(event.Error, websocket.ErrMessageTooBig.Error()) {
				continue
			}
			cancel()
			goto stopped
		case <-deadline:
			cancel()
			t.Fatal("Bridge did not report the explicit WebSocket transport limit")
		}
	}

stopped:
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
	if handled.Load() != 0 {
		t.Fatalf("oversized message reached %d Run handlers", handled.Load())
	}
}

func TestClientRejectsSchemaInvalidCentralMessageBeforeRunHandler(t *testing.T) {
	const privateInstruction = "private instruction must not reach an error"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		invalid := contractRunRequest(
			"run_invalid_envelope",
			"trace_invalid_envelope",
			"agent_invalid_envelope",
		)
		invalid.MessageID = ""
		invalid.Payload.Instruction = privateInstruction
		source, err := json.Marshal(invalid)
		if err != nil {
			t.Error(err)
			return
		}
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		<-request.Context().Done()
	}))
	defer server.Close()

	directory := t.TempDir()
	var handled atomic.Int32
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_invalid_envelope",
			TeamID: "team_invalid_envelope", OwnerMemberID: "member_invalid_envelope",
			Token: "device-secret",
		},
		HandleRun: func(context.Context, contracts.RunRequestedMessage, func(context.Context, any) error) error {
			handled.Add(1)
			return nil
		},
	}
	connected, err := client.connectOnce(context.Background())
	if !connected || !errors.Is(err, runtimecontracts.ErrInvalidBridgeMessage) {
		t.Fatalf("schema-invalid Central message result=(%t, %v)", connected, err)
	}
	if strings.Contains(err.Error(), privateInstruction) {
		t.Fatalf("schema validation error exposed private content: %q", err)
	}
	if handled.Load() != 0 {
		t.Fatalf("schema-invalid Central message reached %d handlers", handled.Load())
	}
}

func TestClientRejectsBinaryCentralMessageBeforeRunHandler(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		source, err := json.Marshal(contractRunRequest(
			"run_binary_envelope",
			"trace_binary_envelope",
			"agent_binary_envelope",
		))
		if err != nil {
			t.Error(err)
			return
		}
		if err := socket.Write(request.Context(), websocket.MessageBinary, source); err != nil {
			return
		}
		<-request.Context().Done()
	}))
	defer server.Close()

	directory := t.TempDir()
	var handled atomic.Int32
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_binary_envelope",
			TeamID: "team_binary_envelope", OwnerMemberID: "member_binary_envelope",
			Token: "device-secret",
		},
		HandleRun: func(context.Context, contracts.RunRequestedMessage, func(context.Context, any) error) error {
			handled.Add(1)
			return nil
		},
	}
	connected, err := client.connectOnce(context.Background())
	if !connected || !errors.Is(err, runtimecontracts.ErrInvalidBridgeMessage) {
		t.Fatalf("binary Central message result=(%t, %v)", connected, err)
	}
	if handled.Load() != 0 {
		t.Fatalf("binary Central message reached %d handlers", handled.Load())
	}
}

func TestRunCancelRequestUsesAnExplicitCancellationCause(t *testing.T) {
	handlerReady := make(chan struct{})
	causeResult := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		requested := contractRunRequest(
			"run_cancel_requested",
			"trace_cancel_requested",
			"agent_cancel_requested",
		)
		source, _ := json.Marshal(requested)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		select {
		case <-handlerReady:
		case <-request.Context().Done():
			return
		}
		canceled := contracts.RunCancelRequestedMessage{
			ProtocolVersion: "1.0", MessageID: "msg_cancel_signal",
			Timestamp: time.Now().UTC(), Type: contracts.RunCancelRequested,
			Payload: contracts.RunCancelRequestedPayload{
				RunID: "run_cancel_requested", TraceID: "trace_cancel_requested",
				AgentID: "agent_cancel_requested", Reason: "user_requested",
			},
		}
		source, _ = json.Marshal(canceled)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		<-request.Context().Done()
	}))
	defer server.Close()

	directory := t.TempDir()
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		HeartbeatInterval: time.Second,
		HandleRun: func(ctx context.Context, _ contracts.RunRequestedMessage, _ func(context.Context, any) error) error {
			close(handlerReady)
			<-ctx.Done()
			causeResult <- context.Cause(ctx)
			return nil
		},
		FenceCanceledRun: func(contracts.RunCancelRequestedMessage) error {
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	select {
	case cause := <-causeResult:
		if !errors.Is(cause, ErrRunCancelRequested) {
			t.Fatalf("Run cancellation cause=%v", cause)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for explicit Run cancellation")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
}

func TestRunCancelRequestWithoutDurableFenceFailsClosed(t *testing.T) {
	handlerReady := make(chan struct{})
	causeResult := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		requested := contractRunRequest(
			"run_cancel_without_fence",
			"trace_cancel_without_fence",
			"agent_cancel_without_fence",
		)
		source, _ := json.Marshal(requested)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		select {
		case <-handlerReady:
		case <-request.Context().Done():
			return
		}
		canceled := contracts.RunCancelRequestedMessage{
			ProtocolVersion: "1.0", MessageID: "msg_cancel_without_fence",
			Timestamp: time.Now().UTC(), Type: contracts.RunCancelRequested,
			Payload: contracts.RunCancelRequestedPayload{
				RunID: "run_cancel_without_fence", TraceID: "trace_cancel_without_fence",
				AgentID: "agent_cancel_without_fence", Reason: "user_requested",
			},
		}
		source, _ = json.Marshal(canceled)
		_ = socket.Write(request.Context(), websocket.MessageText, source)
		<-request.Context().Done()
	}))
	defer server.Close()

	directory := t.TempDir()
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		HeartbeatInterval: time.Second,
		HandleRun: func(ctx context.Context, _ contracts.RunRequestedMessage, _ func(context.Context, any) error) error {
			close(handlerReady)
			<-ctx.Done()
			causeResult <- context.Cause(ctx)
			return nil
		},
	}
	connected, err := client.connectOnce(context.Background())
	if !connected || err == nil || !strings.Contains(err.Error(), "fence is unavailable") {
		t.Fatalf("connectOnce connected=%t error=%v", connected, err)
	}
	select {
	case cause := <-causeResult:
		if errors.Is(cause, ErrRunCancelRequested) {
			t.Fatalf("missing fence applied explicit cancellation: %v", cause)
		}
	case <-time.After(time.Second):
		t.Fatal("active Run worker did not drain")
	}
}

func TestDuplicateRunRequestDoesNotStartAConcurrentHandler(t *testing.T) {
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	duplicateStarted := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		requested := contractRunRequest(
			"run_duplicate_request",
			"trace_duplicate_request",
			"agent_duplicate_request",
		)
		source, _ := json.Marshal(requested)
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		if err := socket.Write(request.Context(), websocket.MessageText, source); err != nil {
			return
		}
		<-request.Context().Done()
	}))
	defer server.Close()

	var invocations atomic.Int32
	directory := t.TempDir()
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		HeartbeatInterval: time.Second,
		HandleRun: func(
			context.Context,
			contracts.RunRequestedMessage,
			func(context.Context, any) error,
		) error {
			if invocations.Add(1) == 1 {
				close(handlerStarted)
			} else {
				close(duplicateStarted)
			}
			<-releaseHandler
			return nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	select {
	case <-handlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the first Run handler")
	}
	select {
	case <-duplicateStarted:
		t.Fatal("duplicate Run request started a concurrent handler")
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseHandler)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Bridge client did not stop")
	}
	if invocations.Load() != 1 {
		t.Fatalf("duplicate Run request invoked %d handlers", invocations.Load())
	}
}

func TestReconnectObserverReportsRealityAndResetsBackoffAfterOnline(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if requests < 3 {
			http.Error(response, "temporarily unavailable", http.StatusServiceUnavailable)
			return
		}
		socket, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		for index := 0; index < 2; index++ {
			if _, _, err := socket.Read(request.Context()); err != nil {
				return
			}
		}
		_ = socket.Close(websocket.StatusGoingAway, "test reconnect")
	}))
	defer server.Close()
	directory := t.TempDir()
	events := make(chan operations.ConnectionEvent, 32)
	client := Client{
		Config: config.Config{
			ServerURL: server.URL, DataDir: directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			ServerURL: server.URL, DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		RetryInitial: time.Millisecond,
		RetryMaximum: 4 * time.Millisecond,
		Observer: operations.Observer{OnConnection: func(event operations.ConnectionEvent) {
			events <- event
		}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	deadline := time.After(2 * time.Second)
	sawOnline := false
	sawReset := false
	for !sawReset {
		select {
		case event := <-events:
			if event.State == operations.ConnectionOnline {
				sawOnline = true
			}
			if sawOnline && event.State == operations.ConnectionRetrying && event.ConnectedOnce {
				if event.NextRetryAt == nil || event.NextRetryAt.Sub(event.At) > 3*time.Millisecond {
					t.Fatalf("backoff was not reset after an online connection: %#v", event)
				}
				sawReset = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for reconnect projection")
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
