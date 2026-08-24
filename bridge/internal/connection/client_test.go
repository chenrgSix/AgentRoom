package connection

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	contracts "agentroom.dev/contracts/generated/go"
	"github.com/coder/websocket"
)

func TestClientAuthenticatesAndSendsHelloAndHeartbeat(t *testing.T) {
	messages := make(chan map[string]any, 3)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer device-secret" {
			http.Error(response, "unauthorized", http.StatusUnauthorized)
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
			ServerURL: server.URL,
			DataDir:   directory,
			Agents: []config.AgentConfig{{
				Name: "Builder", Role: "Implementation", Adapter: "generic",
				Command: []string{"agent"}, Workspace: directory,
			}},
		},
		Credential: pairing.Credential{
			DeviceID: "device_test", TeamID: "team_test",
			OwnerMemberID: "member_test", Token: "device-secret",
		},
		BridgeVersion:     "test",
		HeartbeatInterval: 10 * time.Millisecond,
	}
	done := make(chan error, 1)
	go func() { done <- client.Run(ctx) }()
	hello := <-messages
	publication := <-messages
	heartbeat := <-messages
	if hello["type"] != "bridge.hello" || publication["type"] != "agent.publish" || heartbeat["type"] != "bridge.heartbeat" {
		t.Fatalf("unexpected messages: %#v %#v %#v", hello, publication, heartbeat)
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
		requested := contracts.RunRequestedMessage{
			ProtocolVersion: "1.0", MessageID: "msg_cancel_requested",
			Timestamp: time.Now().UTC(), Type: contracts.RunRequested,
			Payload: contracts.RunRequestedPayload{
				RunID: "run_cancel_requested", TraceID: "trace_cancel_requested",
				TargetAgentID: "agent_cancel_requested",
			},
		}
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
			DeviceID: "device_test", TeamID: "team_test",
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
			DeviceID: "device_test", TeamID: "team_test",
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
