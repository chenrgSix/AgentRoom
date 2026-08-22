package connection

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/pairing"
	contracts "agentroom.dev/contracts/generated/go"
	"github.com/coder/websocket"
)

type Client struct {
	Config            config.Config
	Credential        pairing.Credential
	BridgeVersion     string
	HeartbeatInterval time.Duration
	HandleRun         func(context.Context, contracts.RunRequestedMessage, func(context.Context, any) error) error
	RecoverRuns       func(context.Context, func(context.Context, any) error) error
}

func (c Client) Run(ctx context.Context) error {
	backoff := 500 * time.Millisecond
	for {
		err := c.connectOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
		if err == nil {
			backoff = 500 * time.Millisecond
		}
	}
}

func (c Client) connectOnce(ctx context.Context) error {
	epoch, err := nextEpoch(c.Config.DataDir)
	if err != nil {
		return err
	}
	endpoint, err := websocketURL(c.Config.ServerURL)
	if err != nil {
		return err
	}
	header := make(http.Header)
	header.Set("authorization", "Bearer "+c.Credential.Token)
	socket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: pairing.HTTPClient(c.Config),
		HTTPHeader: header,
	})
	if err != nil {
		if response != nil {
			return fmt.Errorf("bridge WebSocket rejected with status %d: %w", response.StatusCode, err)
		}
		return fmt.Errorf("bridge WebSocket dial: %w", err)
	}
	defer socket.CloseNow()
	hello := contracts.BridgeHelloMessage{
		ProtocolVersion: "1.0",
		MessageID:       newID("msg"),
		Timestamp:       time.Now().UTC(),
		Type:            contracts.BridgeHello,
		Payload: contracts.BridgeHelloPayload{
			BridgeVersion:             c.BridgeVersion,
			ConnectionEpoch:           epoch,
			DeviceID:                  c.Credential.DeviceID,
			SupportedProtocolVersions: []string{"1.0"},
		},
	}
	if err := writeJSON(ctx, socket, hello); err != nil {
		return err
	}
	identities, err := identity.LoadOrCreate(c.Config.DataDir, c.Config.Agents)
	if err != nil {
		return err
	}
	for _, configured := range c.Config.Agents {
		capabilities := contracts.Capabilities{
			InvocationMode:    contracts.Managed,
			SupportsHandoff:   false,
			SupportsInterrupt: true,
			SupportsResume:    false,
			SupportsStart:     true,
			SupportsStreaming: false,
		}
		publication := contracts.AgentPublishMessage{
			ProtocolVersion: "1.0",
			MessageID:       newID("msg"),
			Timestamp:       time.Now().UTC(),
			Type:            contracts.AgentPublish,
			Payload: contracts.AgentPublishPayload{
				AgentID:       identities[configured.Name],
				Capabilities:  capabilities,
				DeviceID:      c.Credential.DeviceID,
				Name:          configured.Name,
				OwnerMemberID: c.Credential.OwnerMemberID,
				Role:          configured.Role,
				TeamID:        c.Credential.TeamID,
			},
		}
		if err := writeJSON(ctx, socket, publication); err != nil {
			return err
		}
	}
	if c.RecoverRuns != nil {
		if err := c.RecoverRuns(ctx, func(sendContext context.Context, value any) error {
			return writeJSON(sendContext, socket, value)
		}); err != nil {
			return err
		}
	}

	readError := make(chan error, 1)
	go func() {
		for {
			_, source, err := socket.Read(ctx)
			if err != nil {
				readError <- err
				return
			}
			var envelope struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(source, &envelope); err != nil {
				readError <- err
				return
			}
			if envelope.Type == "run.requested" && c.HandleRun != nil {
				var requested contracts.RunRequestedMessage
				if err := json.Unmarshal(source, &requested); err != nil {
					readError <- err
					return
				}
				if err := c.HandleRun(ctx, requested, func(sendContext context.Context, value any) error {
					return writeJSON(sendContext, socket, value)
				}); err != nil {
					readError <- err
					return
				}
			}
		}
	}()
	interval := c.HeartbeatInterval
	if interval <= 0 {
		interval = 10 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return socket.Close(websocket.StatusNormalClosure, "Bridge stopped")
		case err := <-readError:
			return err
		case now := <-ticker.C:
			heartbeat := contracts.BridgeHeartbeatMessage{
				ProtocolVersion: "1.0",
				MessageID:       newID("msg"),
				Timestamp:       now.UTC(),
				Type:            contracts.BridgeHeartbeat,
				Payload: contracts.BridgeHeartbeatPayload{
					ConnectionEpoch: epoch,
					DeviceID:        c.Credential.DeviceID,
				},
			}
			if err := writeJSON(ctx, socket, heartbeat); err != nil {
				return err
			}
		}
	}
}

func websocketURL(serverURL string) (string, error) {
	parsed, err := url.Parse(serverURL)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported server URL scheme %q", parsed.Scheme)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/ws/bridge"
	return parsed.String(), nil
}

func writeJSON(ctx context.Context, socket *websocket.Conn, value any) error {
	source, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return socket.Write(ctx, websocket.MessageText, source)
}

func nextEpoch(dataDir string) (int64, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return 0, err
	}
	path := filepath.Join(dataDir, "connection-epoch")
	var current int64
	if source, err := os.ReadFile(path); err == nil {
		current, err = strconv.ParseInt(strings.TrimSpace(string(source)), 10, 64)
		if err != nil || current < 0 {
			return 0, fmt.Errorf("invalid persisted connection epoch")
		}
	} else if !os.IsNotExist(err) {
		return 0, err
	}
	next := current + 1
	temporary, err := os.CreateTemp(dataDir, ".epoch-*")
	if err != nil {
		return 0, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return 0, err
	}
	if _, err := fmt.Fprintf(temporary, "%d\n", next); err != nil {
		temporary.Close()
		return 0, err
	}
	if err := temporary.Close(); err != nil {
		return 0, err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return 0, err
	}
	return next, nil
}

func newID(prefix string) string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(buffer)
}
