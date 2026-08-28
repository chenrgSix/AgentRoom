package connection

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	"agentroom.dev/bridge/internal/workspace"
	contracts "agentroom.dev/contracts/generated/go"
	"github.com/coder/websocket"
)

var (
	ErrRunCancelRequested   = errors.New("Run cancellation requested")
	ErrConfigurationChanged = errors.New("Bridge configuration changed")
)

type ProvisionHandler func(
	context.Context,
	contracts.AgentProvisionRequestedMessage,
) contracts.AgentProvisionResultMessage

// The Bridge protocol permits a Run request with one 32,768-character
// instruction and up to fifty 32,768-character context messages. Sixteen MiB
// covers those defined fields after worst-case UTF-8 and JSON escaping while
// retaining a finite trust-boundary limit for central-server input.
const maxBridgeIncomingMessageBytes int64 = 16 << 20

var (
	provisionIDPattern = regexp.MustCompile(`^agentprov_[A-Za-z0-9_-]{8,128}$`)
	agentIDPattern     = regexp.MustCompile(`^agent_[A-Za-z0-9_-]{8,128}$`)
)

type Client struct {
	Config                            config.Config
	Credential                        pairing.Credential
	BridgeVersion                     string
	HeartbeatInterval                 time.Duration
	HandleRun                         func(context.Context, contracts.RunRequestedMessage, func(context.Context, any) error) error
	HandleProvision                   ProvisionHandler
	RecoverRuns                       func(context.Context, func(context.Context, any) error) error
	Observer                          operations.Observer
	RetryInitial                      time.Duration
	RetryMaximum                      time.Duration
	ResumeAgentNames                  map[string]bool
	StreamingAgentNames               map[string]bool
	RoomContextCoverageAgentNames     map[string]bool
	ArtifactMaterializationAgentNames map[string]bool
}

func publishedRuntimePolicy(agent config.AgentConfig) contracts.RuntimePolicy {
	filesystemAccess := contracts.RuntimePolicyFilesystemAccess("local-policy")
	if agent.RuntimeKind == "codex" || agent.Adapter == "codex" {
		filesystemAccess = contracts.RuntimePolicyFilesystemAccess("workspace-write")
		if agent.Sandbox == "read-only" {
			filesystemAccess = contracts.RuntimePolicyFilesystemAccess("read-only")
		}
	}
	return contracts.RuntimePolicy{FilesystemAccess: filesystemAccess}
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
		if errors.Is(err, ErrConfigurationChanged) {
			return err
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
	credential, trustChanged, trustErr := pairing.SyncScopedPrivateTrustRotation(
		ctx, c.Config, c.Credential, time.Now(),
	)
	if trustChanged {
		if trustErr != nil {
			return false, fmt.Errorf("%w: %v", ErrConfigurationChanged, trustErr)
		}
		return false, ErrConfigurationChanged
	}
	if trustErr != nil {
		return false, trustErr
	}
	c.Credential = credential
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
	if c.Config.ServerToken != "" {
		header.Set(config.ServerTokenHeader, c.Config.ServerToken)
	}
	socket, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: pairing.HTTPClientForCredential(c.Config, c.Credential),
		HTTPHeader: header,
	})
	if err != nil {
		if response != nil {
			return false, fmt.Errorf("bridge WebSocket rejected with status %d: %w", response.StatusCode, err)
		}
		return false, fmt.Errorf("bridge WebSocket dial: %w", err)
	}
	socket.SetReadLimit(maxBridgeIncomingMessageBytes)
	defer socket.CloseNow()
	connectionContext, cancelConnection := context.WithCancel(ctx)
	defer cancelConnection()
	writer := socketWriter{socket: socket}
	supportsAgentProvisioning := c.HandleProvision != nil
	hello := contracts.BridgeHelloMessage{
		ProtocolVersion: "1.0",
		MessageID:       newID("msg"),
		Timestamp:       time.Now().UTC(),
		Type:            contracts.BridgeHello,
		Payload: contracts.BridgeHelloPayload{
			BridgeVersion:             pairing.NormalizedBridgeVersion(c.BridgeVersion),
			ConnectionEpoch:           epoch,
			DeviceID:                  c.Credential.DeviceID,
			SupportsAgentProvisioning: &supportsAgentProvisioning,
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
		agentID := identities[configured.Name]
		runtimeScopeID, err := bridgeruntime.AgentRuntimeScopeID(configured)
		if err != nil {
			return false, fmt.Errorf("resolve Agent Runtime scope: %w", err)
		}
		workspaceSnapshot, err := workspace.Inspect(configured.Workspace)
		if err != nil {
			return false, fmt.Errorf("resolve Agent Workspace snapshot: %w", err)
		}
		capabilities := contracts.Capabilities{
			InvocationMode:    contracts.Managed,
			SupportsHandoff:   false,
			SupportsInterrupt: true,
			SupportsResume:    c.ResumeAgentNames[configured.Name],
			SupportsStart:     true,
			SupportsStreaming: c.StreamingAgentNames[configured.Name],
		}
		supportsRoomContextCoverage :=
			c.RoomContextCoverageAgentNames[configured.Name]
		capabilities.SupportsRoomContextCoverage = &supportsRoomContextCoverage
		supportsWorkspaceLeases := true
		capabilities.SupportsWorkspaceLeases = &supportsWorkspaceLeases
		supportsArtifactPublication := true
		capabilities.SupportsArtifactPublication = &supportsArtifactPublication
		supportsArtifactMaterialization :=
			c.ArtifactMaterializationAgentNames[configured.Name]
		capabilities.SupportsArtifactMaterialization = &supportsArtifactMaterialization
		runtimePolicy := publishedRuntimePolicy(configured)
		workspaceAlias := configured.ResolvedWorkspaceAlias()
		publication := contracts.AgentPublishMessage{
			ProtocolVersion: "1.0",
			MessageID:       newID("msg"),
			Timestamp:       time.Now().UTC(),
			Type:            contracts.AgentPublish,
			Payload: contracts.AgentPublishPayload{
				AgentID:             agentID,
				Capabilities:        capabilities,
				DeviceID:            c.Credential.DeviceID,
				Name:                configured.Name,
				OwnerMemberID:       c.Credential.OwnerMemberID,
				Role:                configured.Role,
				RuntimePolicy:       &runtimePolicy,
				RuntimeScopeID:      &runtimeScopeID,
				WorkspaceAlias:      &workspaceAlias,
				WorkspaceRef:        &workspaceSnapshot.WorkspaceRef,
				WorkspaceGeneration: &workspaceSnapshot.Generation,
				TeamID:              c.Credential.TeamID,
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
		cancel  context.CancelCauseFunc
		token   *struct{}
	}
	active := make(map[string]activeRun)
	var activeMu sync.Mutex
	var runWorkers sync.WaitGroup
	readerDone := make(chan struct{})
	defer func() {
		cancelConnection()
		_ = socket.CloseNow()
		<-readerDone // No more workers may be added once the reader has exited.
		runWorkers.Wait()
	}()
	reportReadError := func(err error) {
		select {
		case readError <- err:
		default:
		}
	}
	go func() {
		defer close(readerDone)
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
				runContext, cancel := context.WithCancelCause(connectionContext)
				token := &struct{}{}
				activeMu.Lock()
				_, alreadyActive := active[requested.Payload.RunID]
				if !alreadyActive {
					active[requested.Payload.RunID] = activeRun{
						agentID: requested.Payload.TargetAgentID, cancel: cancel, token: token,
					}
				}
				activeMu.Unlock()
				if alreadyActive {
					cancel(nil)
					continue
				}
				runWorkers.Add(1)
				go func() {
					defer runWorkers.Done()
					defer cancel(nil)
					err := c.HandleRun(runContext, requested, func(sendContext context.Context, value any) error {
						return writer.writeJSON(sendContext, value)
					})
					activeMu.Lock()
					if active[requested.Payload.RunID].token == token {
						delete(active, requested.Payload.RunID)
					}
					activeMu.Unlock()
					if err != nil {
						reportReadError(err)
					}
				}()
				continue
			}
			if envelope.Type == "agent.provision.requested" && c.HandleProvision != nil {
				var requested contracts.AgentProvisionRequestedMessage
				if err := json.Unmarshal(source, &requested); err != nil {
					reportReadError(err)
					return
				}
				if err := validateProvisionRequest(c.Credential.DeviceID, requested); err != nil {
					reportReadError(err)
					return
				}
				activeMu.Lock()
				busy := len(active) > 0
				activeMu.Unlock()
				result := contracts.AgentProvisionResultMessage{}
				if busy {
					result = ProvisionResult(requested, contracts.Rejected, contracts.ReasonBusy)
				} else {
					result = c.HandleProvision(connectionContext, requested)
				}
				writeErr := writer.writeJSON(connectionContext, result)
				if result.Payload.Status == contracts.Accepted {
					if writeErr != nil {
						reportReadError(fmt.Errorf("%w: send result: %v", ErrConfigurationChanged, writeErr))
					} else {
						reportReadError(ErrConfigurationChanged)
					}
					return
				}
				if writeErr != nil {
					reportReadError(writeErr)
					return
				}
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
					running.cancel(ErrRunCancelRequested)
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
			activeMu.Lock()
			busy := len(active) > 0
			activeMu.Unlock()
			if !busy {
				credential, trustChanged, trustErr := pairing.SyncScopedPrivateTrustRotation(
					ctx, c.Config, c.Credential, now,
				)
				if trustChanged {
					if trustErr != nil {
						return true, fmt.Errorf("%w: %v", ErrConfigurationChanged, trustErr)
					}
					return true, ErrConfigurationChanged
				}
				if trustErr != nil {
					return true, trustErr
				}
				c.Credential = credential
			}
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

func validateProvisionRequest(
	deviceID string,
	requested contracts.AgentProvisionRequestedMessage,
) error {
	payload := requested.Payload
	if requested.ProtocolVersion != "1.0" ||
		requested.Type != contracts.AgentProvisionRequested ||
		payload.DeviceID != deviceID ||
		!provisionIDPattern.MatchString(payload.RequestID) ||
		!agentIDPattern.MatchString(payload.TemplateAgentID) ||
		!agentIDPattern.MatchString(payload.AgentID) ||
		!boundedProvisionLabel(payload.Name) ||
		!boundedProvisionLabel(payload.Role) ||
		!validManagementCode(payload.ManagementCode) {
		return fmt.Errorf("invalid Agent provisioning request")
	}
	return nil
}

func ProvisionResult(
	requested contracts.AgentProvisionRequestedMessage,
	status contracts.PayloadStatus,
	reason contracts.Reason,
) contracts.AgentProvisionResultMessage {
	result := contracts.AgentProvisionResultMessage{
		ProtocolVersion: "1.0",
		MessageID:       newID("msg"),
		Timestamp:       time.Now().UTC(),
		Type:            contracts.AgentProvisionResult,
		Payload: contracts.AgentProvisionResultPayload{
			RequestID:       requested.Payload.RequestID,
			DeviceID:        requested.Payload.DeviceID,
			TemplateAgentID: requested.Payload.TemplateAgentID,
			AgentID:         requested.Payload.AgentID,
			Status:          status,
		},
	}
	if status == contracts.Rejected {
		result.Payload.Reason = &reason
	}
	return result
}

func boundedProvisionLabel(value string) bool {
	length := utf8.RuneCountInString(value)
	return strings.TrimSpace(value) == value && length >= 1 && length <= 80
}

func validManagementCode(value string) bool {
	if len(value) != 6 && len(value) != 8 {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
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
