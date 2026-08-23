package connection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
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
