package connection

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
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
