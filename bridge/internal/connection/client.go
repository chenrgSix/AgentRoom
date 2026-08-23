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
	"sync"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/operations"
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
	Observer          operations.Observer
	RetryInitial      time.Duration
	RetryMaximum      time.Duration
}

func (c Client) Run(ctx context.Context) error {
	initial, maximum := c.retryBounds()
	backoff := initial
	attempt := 0
	for {
		attempt++
		c.Observer.Connection(operations.ConnectionEvent{
			At: time.Now().UTC(), State: operations.ConnectionConnecting, Attempt: attempt,
		})
		connected, err := c.connectOnce(ctx)
		if ctx.Err() != nil {
			c.Observer.Connection(operations.ConnectionEvent{
				At: time.Now().UTC(), State: operations.ConnectionStopped,
			})
			return nil
		}
		if connected {
			backoff = initial
			attempt = 0
		}
		nextRetryAt := time.Now().UTC().Add(backoff)
		errorMessage := ""
		if err != nil {
			errorMessage = err.Error()
		}
		c.Observer.Connection(operations.ConnectionEvent{
			At: time.Now().UTC(), State: operations.ConnectionRetrying, Attempt: attempt,
			NextRetryAt: &nextRetryAt, Error: errorMessage, ConnectedOnce: connected,
		})
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			c.Observer.Connection(operations.ConnectionEvent{
				At: time.Now().UTC(), State: operations.ConnectionStopped,
			})
			return nil
		case <-timer.C:
		}
		if !connected && backoff < maximum {
			backoff *= 2
			if backoff > maximum {
				backoff = maximum
			}
		}
	}
}

func (c Client) retryBounds() (time.Duration, time.Duration) {
	initial := c.RetryInitial
	if initial <= 0 {
		initial = 500 * time.Millisecond
	}
	maximum := c.RetryMaximum
	if maximum <= 0 {
		maximum = 30 * time.Second
	}
	if maximum < initial {
		maximum = initial
	}
	return initial, maximum
}

func (c Client) connectOnce(ctx context.Context) (bool, error) {
	epoch, err := nextEpoch(c.Config.DataDir)
	if err != nil {
		return false, err
	}
	endpoint, err := websocketURL(c.Config.ServerURL)
	if err != nil {
		return false, err
	}
	header := make(http.Header)
	header.Set("authorization", "Bearer "+c.Credential.Token)
	socket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: pairing.HTTPClient(c.Config),
		HTTPHeader: header,
	})
	if err != nil {
		if response != nil {
			return false, fmt.Errorf("bridge WebSocket rejected with status %d: %w", response.StatusCode, err)
		}
		return false, fmt.Errorf("bridge WebSocket dial: %w", err)
	}
	defer socket.CloseNow()
	connectionContext, cancelConnection := context.WithCancel(ctx)
	defer cancelConnection()
	writer := socketWriter{socket: socket}
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
	if err := writer.writeJSON(ctx, hello); err != nil {
		return false, err
	}
	identities, err := identity.LoadOrCreate(c.Config.DataDir, c.Config.Agents)
	if err != nil {
		return false, err
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
		if err := writer.writeJSON(ctx, publication); err != nil {
			return false, err
		}
	}
	if c.RecoverRuns != nil {
		if err := c.RecoverRuns(ctx, func(sendContext context.Context, value any) error {
			return writer.writeJSON(sendContext, value)
		}); err != nil {
			return false, err
		}
	}
	c.Observer.Connection(operations.ConnectionEvent{
		At: time.Now().UTC(), State: operations.ConnectionOnline,
	})

	readError := make(chan error, 1)
	type activeRun struct {
		agentID string
		cancel  context.CancelFunc
		token   *struct{}
	}
	active := make(map[string]activeRun)
	var activeMu sync.Mutex
	reportReadError := func(err error) {
		select {
		case readError <- err:
		default:
		}
	}
	go func() {
		for {
			_, source, err := socket.Read(ctx)
			if err != nil {
				reportReadError(err)
				return
			}
			var envelope struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(source, &envelope); err != nil {
				reportReadError(err)
				return
			}
			if envelope.Type == "run.requested" && c.HandleRun != nil {
				var requested contracts.RunRequestedMessage
				if err := json.Unmarshal(source, &requested); err != nil {
					reportReadError(err)
					return
				}
				runContext, cancel := context.WithCancel(connectionContext)
				token := &struct{}{}
				activeMu.Lock()
				_, alreadyActive := active[requested.Payload.RunID]
				if !alreadyActive {
					active[requested.Payload.RunID] = activeRun{
						agentID: requested.Payload.TargetAgentID, cancel: cancel, token: token,
					}
				}
				activeMu.Unlock()
				go func() {
					defer cancel()
					err := c.HandleRun(runContext, requested, func(sendContext context.Context, value any) error {
						return writer.writeJSON(sendContext, value)
					})
					activeMu.Lock()
					if !alreadyActive && active[requested.Payload.RunID].token == token {
						delete(active, requested.Payload.RunID)
					}
					activeMu.Unlock()
					if err != nil {
						reportReadError(err)
					}
				}()
				continue
			}
			if envelope.Type == "run.cancel_requested" {
				var canceled contracts.RunCancelRequestedMessage
				if err := json.Unmarshal(source, &canceled); err != nil {
					reportReadError(err)
					return
				}
				activeMu.Lock()
				running, exists := active[canceled.Payload.RunID]
				activeMu.Unlock()
				if exists && running.agentID == canceled.Payload.AgentID {
					running.cancel()
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
			return true, socket.Close(websocket.StatusNormalClosure, "Bridge stopped")
		case err := <-readError:
			return true, err
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
			if err := writer.writeJSON(ctx, heartbeat); err != nil {
				return true, err
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

type socketWriter struct {
	socket *websocket.Conn
	mu     sync.Mutex
}

func (w *socketWriter) writeJSON(ctx context.Context, value any) error {
	source, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.socket.Write(ctx, websocket.MessageText, source)
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
