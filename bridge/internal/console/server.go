package console

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/autostart"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/connection"
	"convenewire.dev/bridge/internal/diagnostics"
	"convenewire.dev/bridge/internal/enrollment"
	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/launchable"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/provisioning"
	"convenewire.dev/bridge/internal/updatecheck"
	contracts "convenewire.dev/contracts/generated/go"
)

//go:embed static/*
var staticFiles embed.FS

type Phase string

const (
	PhaseUnconfigured Phase = "unconfigured"
	PhaseReady        Phase = "ready"
	PhaseJoining      Phase = "joining"
	PhaseApproval     Phase = "waiting_approval"
	PhaseRunning      Phase = "running"
	PhaseError        Phase = "error"
)

type RuntimeInput struct {
	Kind                       string                            `json:"kind"`
	Enabled                    bool                              `json:"enabled"`
	Name                       string                            `json:"name"`
	Role                       string                            `json:"role"`
	ExecutablePath             string                            `json:"executablePath"`
	Workspace                  string                            `json:"workspace"`
	WorkspaceAlias             string                            `json:"workspaceAlias,omitempty"`
	Sandbox                    string                            `json:"sandbox,omitempty"`
	CodexSessionConflictPolicy config.CodexSessionConflictPolicy `json:"codexSessionConflictPolicy,omitempty"`
	CredentialEnvironmentVar   string                            `json:"credentialEnvironmentVariable,omitempty"`
}

type EnrollmentInput struct {
	ShareReasoningSummaries *bool            `json:"shareReasoningSummaries,omitempty"`
	ServerURL               string           `json:"serverUrl"`
	ServerToken             string           `json:"serverToken,omitempty"`
	ServerTrustMode         config.TrustMode `json:"serverTrustMode,omitempty"`
	ServerCertificateSHA256 string           `json:"serverCertificateSha256,omitempty"`
	DeviceName              string           `json:"deviceName"`
	Runtimes                []RuntimeInput   `json:"runtimes"`
}

type DevicePairingInput struct {
	EnrollmentInput
	PairingLink      string `json:"pairingLink,omitempty"`
	PairingShortCode string `json:"pairingShortCode,omitempty"`
}

type ConnectionSettingsInput struct {
	ShareReasoningSummaries *bool            `json:"shareReasoningSummaries,omitempty"`
	ServerURL               string           `json:"serverUrl"`
	ServerToken             string           `json:"serverToken,omitempty"`
	ClearServerToken        bool             `json:"clearServerToken,omitempty"`
	ServerTrustMode         config.TrustMode `json:"serverTrustMode,omitempty"`
	ServerCertificateSHA256 string           `json:"serverCertificateSha256,omitempty"`
}

type AgentProvisioningInput struct {
	Mode      config.AgentProvisioningMode `json:"mode"`
	FixedCode string                       `json:"fixedCode,omitempty"`
}

type AgentProvisioningView struct {
	Mode                config.AgentProvisioningMode `json:"mode"`
	FixedCodeConfigured bool                         `json:"fixedCodeConfigured"`
	RotatingCode        string                       `json:"rotatingCode,omitempty"`
	RotatesAt           string                       `json:"rotatesAt,omitempty"`
}

type AgentView struct {
	AgentID                    string                            `json:"agentId"`
	Kind                       string                            `json:"kind"`
	Name                       string                            `json:"name"`
	Role                       string                            `json:"role"`
	ExecutablePath             string                            `json:"executablePath"`
	Workspace                  string                            `json:"workspace"`
	WorkspaceAlias             string                            `json:"workspaceAlias"`
	WorkspaceFilesystemPolicy  string                            `json:"workspaceFilesystemPolicy"`
	WorkspaceNetworkPolicy     string                            `json:"workspaceNetworkPolicy"`
	Sandbox                    string                            `json:"sandbox,omitempty"`
	CodexSessionConflictPolicy config.CodexSessionConflictPolicy `json:"codexSessionConflictPolicy,omitempty"`
	CredentialEnvironmentVar   string                            `json:"credentialEnvironmentVariable,omitempty"`
	ExecutableReady            bool                              `json:"executableReady"`
	RuntimeState               string                            `json:"runtimeState"`
	ActiveRuns                 int                               `json:"activeRuns"`
	LastRunStatus              string                            `json:"lastRunStatus,omitempty"`
	LastRuntimeError           string                            `json:"lastRuntimeError,omitempty"`
	LastRunAt                  string                            `json:"lastRunAt,omitempty"`
}

type ConnectionView struct {
	State              operations.ConnectionState `json:"state"`
	Attempt            int                        `json:"attempt"`
	NextRetryAt        string                     `json:"nextRetryAt,omitempty"`
	LastConnectedAt    string                     `json:"lastConnectedAt,omitempty"`
	LastDisconnectedAt string                     `json:"lastDisconnectedAt,omitempty"`
	LastError          string                     `json:"lastError,omitempty"`
}

type State struct {
	ShareReasoningSummaries bool                        `json:"shareReasoningSummaries"`
	ReasoningEditable       bool                        `json:"reasoningConsentEditable"`
	Phase                   Phase                       `json:"phase"`
	Configured              bool                        `json:"configured"`
	Paired                  bool                        `json:"paired"`
	BridgeRunning           bool                        `json:"bridgeRunning"`
	Version                 string                      `json:"version"`
	ConfigPath              string                      `json:"configPath"`
	Workspace               string                      `json:"workspace"`
	ServerURL               string                      `json:"serverUrl,omitempty"`
	ServerTokenConfigured   bool                        `json:"serverTokenConfigured"`
	ServerTrustMode         config.TrustMode            `json:"serverTrustMode,omitempty"`
	ServerCertificateSHA256 string                      `json:"serverCertificateSha256,omitempty"`
	ActiveServerTrustMode   string                      `json:"activeServerTrustMode,omitempty"`
	ServerTrustEpoch        int64                       `json:"serverTrustEpoch,omitempty"`
	ServerCADigestPrefix    string                      `json:"serverCaDigestPrefix,omitempty"`
	DeviceName              string                      `json:"deviceName,omitempty"`
	TeamID                  string                      `json:"teamId,omitempty"`
	DeviceID                string                      `json:"deviceId,omitempty"`
	JoinCode                string                      `json:"joinCode,omitempty"`
	JoinExpiresAt           string                      `json:"joinExpiresAt,omitempty"`
	LastError               string                      `json:"lastError,omitempty"`
	Agents                  []AgentView                 `json:"agents"`
	DetectedCodex           string                      `json:"detectedCodex,omitempty"`
	DetectedPi              string                      `json:"detectedPi,omitempty"`
	RuntimeDiscovery        map[string]RuntimeDiscovery `json:"runtimeDiscovery"`
	Connection              ConnectionView              `json:"connection"`
	AgentProvisioning       AgentProvisioningView       `json:"agentProvisioning"`
	LoginStartup            autostart.State             `json:"loginStartup"`
	Enrollment              EnrollmentView              `json:"enrollment"`
}

type Dependencies struct {
	DiscoverRuntime           func(string) RuntimeDiscovery
	Enroll                    func(context.Context, config.Config, func(enrollment.Challenge)) (pairing.Credential, error)
	PairDevice                func(context.Context, config.Config, pairing.SessionInput, func(pairing.SessionStatus)) (pairing.Credential, error)
	SaveConfig                func(string, config.Config) error
	ReplaceConfig             func(string, config.Config) error
	SaveCredential            func(string, pairing.Credential) error
	ReplaceCredential         func(string, pairing.Credential, pairing.Credential) error
	MigrateScopedPrivateTrust func(context.Context, pairing.Credential, string) (pairing.Credential, error)
	RunBridge                 func(context.Context, config.Config, pairing.Credential, operations.Observer) error
	RunBridgeWithProvisioning func(
		context.Context,
		config.Config,
		pairing.Credential,
		operations.Observer,
		connection.ProvisionHandler,
	) error
	LoginStartup  autostart.Controller
	UpdateChecker updatecheck.Service
	ProbeRuntime  func(context.Context, config.AgentConfig) RuntimeProbeResult
}

type Options struct {
	ConfigPath     string
	DataDir        string
	Workspace      string
	Token          string
	Version        string
	DiagnosticsDir string
}

type Service struct {
	mu                     sync.Mutex
	options                Options
	dependencies           Dependencies
	tokenHash              [32]byte
	token                  string
	state                  State
	configuration          *config.Config
	credential             *pairing.Credential
	joinCancel             context.CancelFunc
	joinEpoch              uint64
	bridgeCancel           context.CancelFunc
	bridgeEpoch            uint64
	bridgeWorkers          int
	events                 []diagnostics.Event
	runtimeTests           map[string]struct{}
	runtimePreflight       bool
	provisioningAuthorizer provisioning.Authorizer
}

var environmentName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,79}$`)

func New(options Options, dependencies Dependencies) (*Service, error) {
	if dependencies.DiscoverRuntime == nil {
		dependencies.DiscoverRuntime = discoverRuntime
	}
	if dependencies.ReplaceCredential == nil {
		dependencies.ReplaceCredential = pairing.Replace
	}
	if dependencies.MigrateScopedPrivateTrust == nil {
		dependencies.MigrateScopedPrivateTrust = func(
			ctx context.Context,
			credential pairing.Credential,
			targetOrigin string,
		) (pairing.Credential, error) {
			return pairing.MigrateScopedPrivateTrustOrigin(
				ctx, credential, targetOrigin, time.Now(),
			)
		}
	}
	if dependencies.Enroll == nil || dependencies.SaveConfig == nil || dependencies.ReplaceConfig == nil ||
		dependencies.SaveCredential == nil || dependencies.RunBridge == nil {
		return nil, fmt.Errorf("Console dependencies are incomplete")
	}
	resolvedConfig, err := filepath.Abs(options.ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("resolve Console config path: %w", err)
	}
	resolvedData := options.DataDir
	if resolvedData == "" {
		resolvedData = filepath.Join(filepath.Dir(resolvedConfig), "data")
	}
	resolvedData, err = filepath.Abs(resolvedData)
	if err != nil {
		return nil, fmt.Errorf("resolve Console data directory: %w", err)
	}
	workspace := options.Workspace
	if workspace == "" {
		workspace, err = os.Getwd()
	} else {
		workspace, err = filepath.Abs(workspace)
	}
	if err != nil {
		return nil, fmt.Errorf("resolve Console workspace: %w", err)
	}
	bridgeVersion := strings.TrimSpace(options.Version)
	if bridgeVersion == "" {
		bridgeVersion = "dev"
	}
	token := options.Token
	if token == "" {
		token, err = randomToken()
		if err != nil {
			return nil, err
		}
	}
	service := &Service{
		options: Options{
			ConfigPath:     resolvedConfig,
			DataDir:        resolvedData,
			Workspace:      workspace,
			Token:          token,
			Version:        bridgeVersion,
			DiagnosticsDir: options.DiagnosticsDir,
		},
		dependencies: dependencies,
		token:        token,
		tokenHash:    sha256.Sum256([]byte(token)),
		state: State{
			Phase:             PhaseUnconfigured,
			ConfigPath:        resolvedConfig,
			Workspace:         workspace,
			Version:           bridgeVersion,
			Agents:            []AgentView{},
			Connection:        ConnectionView{State: operations.ConnectionStopped},
			AgentProvisioning: AgentProvisioningView{Mode: config.AgentProvisioningDisabled},
		},
		runtimeTests: make(map[string]struct{}),
	}
	service.applyDiscoveryLocked(service.discoverRuntimes())
	if loaded, loadErr := config.Load(resolvedConfig); loadErr == nil {
		service.configuration = &loaded
		service.state.Configured = true
		service.state.Phase = PhaseReady
		if err := service.applyConfigView(loaded); err != nil {
			return nil, err
		}
		if credential, credentialErr := pairing.Load(loaded.DataDir); credentialErr == nil {
			service.credential = &credential
			service.applyCredentialTrustViewLocked(credential)
			service.state.Paired = true
			service.state.TeamID = credential.TeamID
			service.state.DeviceID = credential.DeviceID
			backupPath := filepath.Join(loaded.DataDir, "previous-bridge.json")
			if info, err := os.Lstat(backupPath); err == nil && info.Mode().IsRegular() {
				service.state.Enrollment.BackupConfigPath = backupPath
			}
		}
	} else if !errors.Is(rootError(loadErr), os.ErrNotExist) {
		return nil, loadErr
	}
	if dependencies.LoginStartup != nil {
		startupState, startupErr := dependencies.LoginStartup.State()
		if startupErr != nil {
			service.state.LastError = publicError(startupErr)
		} else {
			service.state.LoginStartup = startupState
		}
	}
	return service, nil
}

func (s *Service) Token() string { return s.token }

func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot := cloneState(s.state)
	if s.configuration != nil {
		snapshot.AgentProvisioning = agentProvisioningView(
			s.configuration.AgentProvisioning,
			time.Now(),
		)
	}
	snapshot.Enrollment.Active = s.joinCancel != nil
	snapshot.Enrollment.BlockedReason = s.enrollmentBlockedReasonLocked()
	snapshot.Enrollment.CanRequest = snapshot.Enrollment.BlockedReason == ""
	snapshot.ReasoningEditable = s.reasoningConsentEditableLocked()
	if deadline, err := time.Parse(time.RFC3339Nano, snapshot.JoinExpiresAt); snapshot.Enrollment.Active && err == nil && !time.Now().Before(deadline) {
		snapshot.JoinCode = ""
		snapshot.Enrollment.CodeExpired = true
	}
	for index := range snapshot.Agents {
		agent := &snapshot.Agents[index]
		agent.ExecutableReady = executableAvailable(agent.ExecutablePath)
		if agent.ActiveRuns == 0 {
			if !agent.ExecutableReady {
				agent.RuntimeState = "unavailable"
			} else if agent.RuntimeState == "unavailable" {
				agent.RuntimeState = string(operations.RuntimeIdle)
			}
		}
	}
	return snapshot
}

func (s *Service) Handler() http.Handler {
	staticRoot, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/state", s.authorize(s.getState))
	mux.HandleFunc("GET /api/runtime-discovery", s.authorize(s.refreshRuntimeDiscovery))
	mux.HandleFunc("POST /api/enrollment/start", s.authorize(s.startEnrollment))
	mux.HandleFunc("POST /api/device-pairing/start", s.authorize(s.startDevicePairing))
	mux.HandleFunc("POST /api/enrollment/restart", s.authorize(s.restartEnrollment))
	mux.HandleFunc("POST /api/enrollment/cancel", s.authorize(s.cancelEnrollment))
	mux.HandleFunc("PUT /api/config", s.authorize(s.updateConfig))
	mux.HandleFunc("PUT /api/connection-settings", s.authorize(s.updateConnectionSettings))
	mux.HandleFunc("PUT /api/agent-provisioning", s.authorize(s.updateAgentProvisioning))
	mux.HandleFunc("POST /api/agents", s.authorize(s.addAgent))
	mux.HandleFunc("PUT /api/agents/{agentId}", s.authorize(s.updateAgent))
	mux.HandleFunc("POST /api/runtime-tests", s.authorize(s.testRuntime))
	mux.HandleFunc("POST /api/runtime-preflight", s.authorize(s.preflightRuntime))
	mux.HandleFunc("POST /api/bridge/start", s.authorize(s.startBridge))
	mux.HandleFunc("POST /api/bridge/stop", s.authorize(s.stopBridge))
	mux.HandleFunc("POST /api/reasoning-consent/prepare", s.authorize(s.prepareReasoningConsent))
	mux.HandleFunc("PUT /api/login-startup", s.authorize(s.updateLoginStartup))
	mux.HandleFunc("POST /api/diagnostics/export", s.authorize(s.exportDiagnostics))
	mux.HandleFunc("POST /api/update/check", s.authorize(s.checkUpdate))
	mux.Handle("/", securityHeaders(http.FileServer(http.FS(staticRoot))))
	return mux
}

func (s *Service) testRuntime(response http.ResponseWriter, request *http.Request) {
	if s.dependencies.ProbeRuntime == nil {
		writeError(response, http.StatusNotImplemented, "Runtime self-test is not available")
		return
	}
	var input struct {
		AgentID   string `json:"agentId"`
		AgentName string `json:"agentName"`
	}
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	agentID := strings.TrimSpace(input.AgentID)
	name := strings.TrimSpace(input.AgentName)
	if agentID == "" && name == "" {
		writeError(response, http.StatusBadRequest, "agentId is required")
		return
	}
	s.mu.Lock()
	if s.joinCancel != nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Wait for Team enrollment to finish before testing a Runtime")
		return
	}
	if s.runtimePreflight {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Wait for the Runtime preflight to finish")
		return
	}
	if s.configuration == nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Configure the Bridge before testing a Runtime")
		return
	}
	identities, err := identity.LoadOrCreate(s.configuration.DataDir, s.configuration.Agents)
	if err != nil {
		s.mu.Unlock()
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	var selected *config.AgentConfig
	for index, agent := range s.configuration.Agents {
		if agentID != "" && identities[agent.Name] != agentID {
			continue
		}
		if agentID == "" && agent.Name != name {
			continue
		}
		if index < len(s.state.Agents) && s.state.Agents[index].ActiveRuns > 0 {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, "Runtime has an active Team task")
			return
		}
		if agent.RuntimeKind != "codex" && agent.RuntimeKind != "pi" {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, "Runtime self-test requires a managed Codex or Pi preset")
			return
		}
		testKey := identities[agent.Name]
		if _, running := s.runtimeTests[testKey]; running {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, "Runtime self-test is already running")
			return
		}
		copy := agent
		copy.Command = append([]string{}, agent.Command...)
		copy.EnvAllowlist = append([]string{}, agent.EnvAllowlist...)
		selected = &copy
		agentID = testKey
		s.runtimeTests[testKey] = struct{}{}
		break
	}
	s.mu.Unlock()
	if selected == nil {
		writeError(response, http.StatusNotFound, "Configured Runtime was not found")
		return
	}
	defer func() {
		s.mu.Lock()
		delete(s.runtimeTests, agentID)
		s.mu.Unlock()
	}()
	probeContext, cancel := context.WithTimeout(request.Context(), time.Minute)
	defer cancel()
	result := s.dependencies.ProbeRuntime(probeContext, *selected)
	writeJSON(response, http.StatusOK, result)
}

func (s *Service) preflightRuntime(response http.ResponseWriter, request *http.Request) {
	if s.dependencies.ProbeRuntime == nil {
		writeError(response, http.StatusNotImplemented, "Runtime preflight is not available")
		return
	}
	var input RuntimeInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	agent, err := buildRuntime(input)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	if s.joinCancel != nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Wait for Team enrollment to finish before testing a draft")
		return
	}
	if s.runtimePreflight || len(s.runtimeTests) > 0 {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Another Runtime test is already running")
		return
	}
	for _, configured := range s.state.Agents {
		if configured.ActiveRuns > 0 {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, "Runtime preflight is blocked by an active Team task")
			return
		}
	}
	s.runtimePreflight = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.runtimePreflight = false
		s.mu.Unlock()
	}()
	probeContext, cancel := context.WithTimeout(request.Context(), time.Minute)
	defer cancel()
	writeJSON(response, http.StatusOK, s.dependencies.ProbeRuntime(probeContext, agent))
}

func (s *Service) updateLoginStartup(response http.ResponseWriter, request *http.Request) {
	if s.dependencies.LoginStartup == nil {
		writeError(response, http.StatusNotImplemented, "Login startup is not supported by this client")
		return
	}
	var input struct {
		Enabled bool `json:"enabled"`
	}
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	state, err := s.dependencies.LoginStartup.SetEnabled(request.Context(), input.Enabled)
	if err != nil {
		writeError(response, http.StatusConflict, publicError(err))
		return
	}
	s.mu.Lock()
	s.state.LoginStartup = state
	s.recordEventLocked("login_startup.changed", fmt.Sprintf("enabled=%t", state.Enabled), "")
	s.mu.Unlock()
	writeJSON(response, http.StatusOK, state)
}

func (s *Service) exportDiagnostics(response http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	input := s.diagnosticInputLocked()
	directory := s.options.DiagnosticsDir
	s.mu.Unlock()
	result, err := diagnostics.Export(directory, input)
	if err != nil {
		writeError(response, http.StatusInternalServerError, diagnostics.Sanitize(err.Error()))
		return
	}
	writeJSON(response, http.StatusCreated, result)
}

func (s *Service) checkUpdate(response http.ResponseWriter, request *http.Request) {
	if s.dependencies.UpdateChecker == nil {
		writeError(response, http.StatusNotImplemented, "Update checking is not available")
		return
	}
	s.mu.Lock()
	currentVersion := s.state.Version
	s.mu.Unlock()
	result, err := s.dependencies.UpdateChecker.Check(request.Context(), currentVersion)
	if err != nil {
		writeError(response, http.StatusBadGateway, diagnostics.Sanitize(err.Error()))
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (s *Service) StartConfiguredBridge() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.configuration == nil || s.credential == nil {
		return nil
	}
	return s.startBridgeLocked()
}

// StartBridge starts an enrolled Bridge and returns a snapshot of its new
// state. It is shared by the HTTP Console and native desktop controls.
func (s *Service) StartBridge() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.startBridgeLocked(); err != nil {
		return cloneState(s.state), err
	}
	return cloneState(s.state), nil
}

// StopBridge stops the current managed connection without closing the local
// configuration surface. Starting it again reuses the stored identity.
func (s *Service) StopBridge() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopBridgeLocked()
}

func (s *Service) stopBridgeLocked() State {
	if s.joinCancel != nil {
		return cloneState(s.state)
	}
	if s.bridgeCancel != nil {
		s.bridgeCancel()
	}
	s.bridgeEpoch++
	s.bridgeCancel = nil
	s.state.BridgeRunning = false
	s.state.Connection = ConnectionView{State: operations.ConnectionStopped}
	s.recordEventLocked("bridge.stopped", "", string(operations.ConnectionStopped))
	s.state.Phase = phaseFor(s.state.Configured, false)
	return cloneState(s.state)
}

func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.joinCancel != nil {
		s.joinCancel()
		s.joinCancel = nil
	}
	s.joinEpoch++
	if s.bridgeCancel != nil {
		s.bridgeCancel()
		s.bridgeCancel = nil
		s.bridgeEpoch++
	}
}

func ListenLoopback(address string) (net.Listener, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("Console listen address must include host and port: %w", err)
	}
	if host != "localhost" {
		ip := net.ParseIP(strings.Trim(host, "[]"))
		if ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("Console may listen only on a loopback address")
		}
	}
	return net.Listen("tcp", address)
}

func (s *Service) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		provided := strings.TrimPrefix(request.Header.Get("authorization"), "Bearer ")
		providedHash := sha256.Sum256([]byte(provided))
		if provided == "" || subtle.ConstantTimeCompare(providedHash[:], s.tokenHash[:]) != 1 {
			writeError(response, http.StatusUnauthorized, "Console token is required")
			return
		}
		securityHeaders(http.HandlerFunc(next)).ServeHTTP(response, request)
	}
}

func (s *Service) getState(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, s.State())
}

func (s *Service) startEnrollment(response http.ResponseWriter, request *http.Request) {
	var input EnrollmentInput
	if err := decodeJSON(request, &input); err != nil && !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	if reason := s.enrollmentBlockedReasonLocked(); reason != "" {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, reason)
		return
	}
	if s.credential != nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Use explicit re-enrollment to request a new Device identity")
		return
	}
	configuredBefore := s.configuration != nil
	configuration := s.configuration
	if configuration == nil {
		built, err := buildConfig(input, s.options.DataDir)
		if err != nil {
			s.mu.Unlock()
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := config.EnsureAvailable(s.options.ConfigPath); err != nil {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, err.Error())
			return
		}
		if _, err := pairing.EnsureAvailable(built.DataDir); err != nil {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, err.Error())
			return
		}
		configuration = &built
	}
	if err := s.applyConfigView(*configuration); err != nil {
		s.mu.Unlock()
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	ctx, epoch := s.beginEnrollmentLocked(false)
	s.mu.Unlock()

	go s.enroll(ctx, *configuration, configuredBefore, false, epoch)
	writeJSON(response, http.StatusAccepted, map[string]string{"status": "joining"})
}

func (s *Service) startDevicePairing(response http.ResponseWriter, request *http.Request) {
	if s.dependencies.PairDevice == nil {
		writeError(response, http.StatusNotImplemented, "Device pairing is not available in this client")
		return
	}
	var input DevicePairingInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	link := strings.TrimSpace(input.PairingLink)
	shortCode := strings.TrimSpace(input.PairingShortCode)
	if (link == "") == (shortCode == "") {
		writeError(response, http.StatusBadRequest, "Provide exactly one Device pairing link or short code")
		return
	}
	s.mu.Lock()
	if reason := s.enrollmentBlockedReasonLocked(); reason != "" {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, reason)
		return
	}
	if s.credential != nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Use explicit re-enrollment to request a new Device identity")
		return
	}
	configuredBefore := s.configuration != nil
	configuration := s.configuration
	if configuration == nil {
		built, err := buildConfig(input.EnrollmentInput, s.options.DataDir)
		if err != nil {
			s.mu.Unlock()
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
		if _, err := config.EnsureAvailable(s.options.ConfigPath); err != nil {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, err.Error())
			return
		}
		if _, err := pairing.EnsureAvailable(built.DataDir); err != nil {
			s.mu.Unlock()
			writeError(response, http.StatusConflict, err.Error())
			return
		}
		configuration = &built
	}
	if err := s.applyConfigView(*configuration); err != nil {
		s.mu.Unlock()
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	ctx, epoch := s.beginEnrollmentLocked(false)
	method := "link"
	if shortCode != "" {
		method = "short_code"
	}
	s.state.Enrollment.PairingMethod = method
	s.state.Enrollment.PairingState = "claiming"
	s.mu.Unlock()

	go s.pairDevice(ctx, *configuration, configuredBefore, epoch, pairing.SessionInput{
		Link: link, ShortCode: shortCode,
	})
	writeJSON(response, http.StatusAccepted, map[string]string{"status": "pairing"})
}

func (s *Service) enroll(ctx context.Context, configuration config.Config, configuredBefore, recovery bool, epoch uint64) {
	credential, err := s.dependencies.Enroll(ctx, configuration, func(challenge enrollment.Challenge) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.joinEpoch != epoch || ctx.Err() != nil || s.joinCancel == nil {
			return
		}
		s.state.Phase = PhaseApproval
		s.state.JoinCode = challenge.UserCode
		s.state.JoinExpiresAt = challenge.ExpiresAt.Format(time.RFC3339Nano)
	})
	s.finishEnrollment(ctx, configuration, credential, err, configuredBefore, recovery, epoch)
}

func (s *Service) pairDevice(
	ctx context.Context,
	configuration config.Config,
	configuredBefore bool,
	epoch uint64,
	input pairing.SessionInput,
) {
	credential, err := s.dependencies.PairDevice(ctx, configuration, input, func(status pairing.SessionStatus) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.joinEpoch != epoch || ctx.Err() != nil || s.joinCancel == nil {
			return
		}
		s.state.Phase = PhaseApproval
		s.state.Enrollment.PairingState = status.State
		s.state.Enrollment.PairingSessionID = status.PairingSessionID
		s.state.Enrollment.VerificationPhrase = status.VerificationPhrase
		s.state.Enrollment.PairingExpiresAt = status.ExpiresAt.Format(time.RFC3339Nano)
	})
	s.finishEnrollment(ctx, configuration, credential, err, configuredBefore, false, epoch)
}

func (s *Service) finishEnrollment(
	ctx context.Context,
	configuration config.Config,
	credential pairing.Credential,
	err error,
	configuredBefore bool,
	recovery bool,
	epoch uint64,
) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.joinEpoch != epoch || ctx.Err() != nil {
		return
	}
	if err == nil && recovery {
		configuration, err = s.installReEnrollmentLocked(configuration, credential)
	} else if err == nil {
		if !configuredBefore {
			err = s.dependencies.SaveConfig(s.options.ConfigPath, configuration)
			if err == nil {
				s.configuration = &configuration
				s.state.Configured = true
			}
		}
		if err == nil {
			err = s.dependencies.SaveCredential(configuration.DataDir, credential)
		}
	}
	if s.joinCancel != nil {
		s.joinCancel()
		s.joinCancel = nil
	}
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
	pairingMethod := s.state.Enrollment.PairingMethod
	s.clearDevicePairingLocked()
	if errors.Is(err, context.Canceled) {
		s.state.Phase = phaseFor(s.state.Configured, s.state.BridgeRunning)
		s.state.LastError = ""
		return
	}
	if err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = diagnostics.Sanitize(publicError(err))
		return
	}
	s.configuration = &configuration
	s.credential = &credential
	s.applyCredentialTrustViewLocked(credential)
	s.state.Configured = true
	s.state.Paired = true
	s.state.TeamID = credential.TeamID
	s.state.DeviceID = credential.DeviceID
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
	if pairingMethod != "" {
		s.state.Enrollment.PairingMethod = pairingMethod
		s.state.Enrollment.PairingState = "consumed"
	}
	s.state.Phase = PhaseReady
	err = s.startBridgeLocked()
	if err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
	}
}

func (s *Service) cancelEnrollment(response http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.joinCancel != nil {
		s.joinCancel()
		s.joinCancel = nil
	}
	s.joinEpoch++
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
	s.clearDevicePairingLocked()
	s.state.LastError = ""
	s.state.Enrollment.Recovery = false
	s.state.Phase = phaseFor(s.state.Configured, s.state.BridgeRunning)
	writeJSON(response, http.StatusOK, s.state)
}

func (s *Service) startBridge(response http.ResponseWriter, _ *http.Request) {
	state, err := s.StartBridge()
	if err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	writeJSON(response, http.StatusAccepted, state)
}

func (s *Service) startBridgeLocked() error {
	if s.joinCancel != nil {
		return fmt.Errorf("Finish or cancel Team enrollment before starting the Bridge")
	}
	if s.bridgeCancel != nil {
		return nil
	}
	if s.configuration == nil || s.credential == nil {
		return fmt.Errorf("Bridge must be configured and paired before start")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.bridgeEpoch++
	epoch := s.bridgeEpoch
	s.bridgeCancel = cancel
	s.bridgeWorkers++
	s.state.BridgeRunning = true
	s.state.Phase = PhaseRunning
	s.state.LastError = ""
	s.state.Connection = ConnectionView{State: operations.ConnectionConnecting, Attempt: 1}
	s.recordEventLocked("bridge.started", "", string(operations.ConnectionConnecting))
	configuration := *s.configuration
	credential := *s.credential
	provisionHandler := connection.ProvisionHandler(func(
		handlerContext context.Context,
		requested contracts.AgentProvisionRequestedMessage,
	) contracts.AgentProvisionResultMessage {
		return s.handleAgentProvision(handlerContext, epoch, requested)
	})
	go func() {
		var err error
		if s.dependencies.RunBridgeWithProvisioning != nil {
			err = s.dependencies.RunBridgeWithProvisioning(
				ctx,
				configuration,
				credential,
				s.operationalObserver(epoch),
				provisionHandler,
			)
		} else {
			err = s.dependencies.RunBridge(ctx, configuration, credential, s.operationalObserver(epoch))
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		s.bridgeWorkers--
		if s.bridgeWorkers == 0 {
			for index := range s.state.Agents {
				s.state.Agents[index].ActiveRuns = 0
				if s.state.Agents[index].RuntimeState == string(operations.RuntimeWorking) {
					s.state.Agents[index].RuntimeState = string(operations.RuntimeIdle)
				}
			}
		}
		if s.bridgeEpoch != epoch {
			return
		}
		s.bridgeCancel = nil
		s.state.BridgeRunning = false
		s.state.Connection.State = operations.ConnectionStopped
		if errors.Is(err, connection.ErrConfigurationChanged) && ctx.Err() == nil {
			if s.configuration != nil {
				reloadedCredential, credentialErr := pairing.Load(s.configuration.DataDir)
				if credentialErr != nil {
					s.state.Phase = PhaseError
					s.state.LastError = publicError(credentialErr)
					return
				}
				s.credential = &reloadedCredential
				s.applyCredentialTrustViewLocked(reloadedCredential)
			}
			s.state.Phase = PhaseReady
			if restartErr := s.startBridgeLocked(); restartErr != nil {
				s.state.Phase = PhaseError
				s.state.LastError = publicError(restartErr)
			}
			return
		}
		if err != nil && !errors.Is(err, context.Canceled) && ctx.Err() == nil {
			s.state.Phase = PhaseError
			s.state.LastError = publicError(err)
			return
		}
		s.state.Phase = PhaseReady
	}()
	return nil
}

func (s *Service) handleAgentProvision(
	_ context.Context,
	epoch uint64,
	requested contracts.AgentProvisionRequestedMessage,
) contracts.AgentProvisionResultMessage {
	reject := func(reason contracts.Reason) contracts.AgentProvisionResultMessage {
		return connection.ProvisionResult(requested, contracts.Rejected, reason)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bridgeEpoch != epoch || s.configuration == nil || s.credential == nil {
		return reject(contracts.ReasonBusy)
	}
	if valid, reason := s.provisioningAuthorizer.Verify(
		s.configuration.AgentProvisioning,
		requested.Payload.ManagementCode,
		time.Now(),
	); !valid {
		return reject(reason)
	}
	if err := s.requireConfigurationMutationLocked(); err != nil {
		return reject(contracts.ReasonBusy)
	}
	decision := provisioning.ApplyAuthorized(
		*s.configuration,
		s.options.ConfigPath,
		s.dependencies.ReplaceConfig,
		requested.Payload,
	)
	if !decision.Accepted {
		return reject(decision.Reason)
	}
	s.configuration = &decision.Configuration
	if err := s.applyConfigView(decision.Configuration); err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
	}
	s.recordEventLocked("agent_provisioning.accepted", "", "accepted")
	return connection.ProvisionResult(requested, contracts.Accepted, "")
}

func (s *Service) stopBridge(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, s.StopBridge())
}

func (s *Service) prepareReasoningConsent(response http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireConfigurationMutationLocked(); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, s.stopBridgeLocked())
}

func (s *Service) addAgent(response http.ResponseWriter, request *http.Request) {
	var input RuntimeInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	agent, err := buildRuntime(input)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireConfigurationMutationLocked(); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	candidate := cloneConfiguration(*s.configuration)
	candidate.Agents = append(candidate.Agents, agent)
	if err := candidate.Validate(); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	identities, err := identity.LoadOrCreate(candidate.DataDir, candidate.Agents)
	if err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	if err := s.replaceConfigurationLocked(candidate); err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	writeJSON(response, http.StatusCreated, s.agentViewLocked(identities[agent.Name]))
}

func (s *Service) updateAgent(response http.ResponseWriter, request *http.Request) {
	agentID := strings.TrimSpace(request.PathValue("agentId"))
	if agentID == "" {
		writeError(response, http.StatusBadRequest, "agentId is required")
		return
	}
	var input RuntimeInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	agent, err := buildRuntime(input)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireConfigurationMutationLocked(); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	identities, err := identity.LoadOrCreate(s.configuration.DataDir, s.configuration.Agents)
	if err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	candidate := cloneConfiguration(*s.configuration)
	selected := -1
	for index, configured := range candidate.Agents {
		if identities[configured.Name] == agentID {
			selected = index
			break
		}
	}
	if selected < 0 {
		writeError(response, http.StatusNotFound, "Configured Agent was not found")
		return
	}
	previous := candidate.Agents[selected]
	if agent.RuntimeKind == "codex" && previous.RuntimeKind == "codex" &&
		input.CodexSessionConflictPolicy == "" {
		agent.CodexSessionConflictPolicy = previous.ResolvedCodexSessionConflictPolicy()
	}
	if agent.RuntimeKind == "pi" && previous.RuntimeKind == "pi" &&
		len(agent.Command) > 0 {
		agent.Command = config.PiPresetCommand(
			agent.Command[0],
			config.PiLocalPolicyArguments(previous.Command, previous.PresetVersion)...,
		)
	}
	candidate.Agents[selected] = agent
	if err := candidate.Validate(); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if err := identity.BindName(candidate.DataDir, agent.Name, agentID); err != nil {
		writeError(response, http.StatusConflict, publicError(err))
		return
	}
	if err := s.replaceConfigurationLocked(candidate); err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	writeJSON(response, http.StatusOK, s.agentViewLocked(agentID))
}

func (s *Service) requireConfigurationMutationLocked() error {
	if s.configuration == nil || s.credential == nil {
		return fmt.Errorf("Complete Team enrollment before editing configuration")
	}
	if s.joinCancel != nil {
		return fmt.Errorf("Wait for Team enrollment to finish before editing configuration")
	}
	if len(s.runtimeTests) > 0 {
		return fmt.Errorf("Wait for Runtime self-tests to finish before editing configuration")
	}
	if s.runtimePreflight {
		return fmt.Errorf("Wait for the Runtime preflight to finish before editing configuration")
	}
	for _, agent := range s.state.Agents {
		if agent.ActiveRuns > 0 {
			return fmt.Errorf("Wait for active Team tasks to finish before editing configuration")
		}
	}
	return nil
}

func (s *Service) replaceConfigurationLocked(configuration config.Config) error {
	if err := s.requireReasoningConsentChangeLocked(configuration); err != nil {
		return err
	}
	if err := s.dependencies.ReplaceConfig(s.options.ConfigPath, configuration); err != nil {
		return err
	}
	return s.applyReplacedConfigurationLocked(configuration)
}

func (s *Service) applyReplacedConfigurationLocked(configuration config.Config) error {
	wasRunning := s.bridgeCancel != nil
	if s.bridgeCancel != nil {
		s.bridgeCancel()
	}
	s.bridgeEpoch++
	s.bridgeCancel = nil
	s.state.BridgeRunning = false
	s.state.Connection = ConnectionView{State: operations.ConnectionStopped}
	s.configuration = &configuration
	if err := s.applyConfigView(configuration); err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
		return err
	}
	s.state.Phase = PhaseReady
	if wasRunning {
		return s.startBridgeLocked()
	}
	return nil
}

func (s *Service) agentViewLocked(agentID string) AgentView {
	for _, agent := range s.state.Agents {
		if agent.AgentID == agentID {
			return agent
		}
	}
	return AgentView{}
}

func cloneConfiguration(source config.Config) config.Config {
	clone := source
	clone.Agents = make([]config.AgentConfig, len(source.Agents))
	for index, agent := range source.Agents {
		clone.Agents[index] = agent
		clone.Agents[index].Command = append([]string{}, agent.Command...)
		clone.Agents[index].EnvAllowlist = append([]string{}, agent.EnvAllowlist...)
	}
	return clone
}

func (s *Service) updateConnectionSettings(response http.ResponseWriter, request *http.Request) {
	var input ConnectionSettingsInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireConfigurationMutationLocked(); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	candidate := cloneConfiguration(*s.configuration)
	candidate.ServerURL = strings.TrimSpace(input.ServerURL)
	candidate.ShareReasoningSummaries = reasoningConsentForUpdate(
		*s.configuration, candidate.ServerURL, input.ShareReasoningSummaries,
	)
	if err := s.requireReasoningConsentChangeLocked(candidate); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	replacementToken := strings.TrimSpace(input.ServerToken)
	if input.ClearServerToken && replacementToken != "" {
		writeError(response, http.StatusBadRequest, "serverToken cannot be replaced and cleared together")
		return
	}
	if input.ClearServerToken {
		candidate.ServerToken = ""
	} else if replacementToken != "" {
		candidate.ServerToken = replacementToken
	}
	candidate.ServerTrustMode = input.ServerTrustMode
	candidate.ServerCertificateSHA256 = strings.TrimSpace(input.ServerCertificateSHA256)
	if err := candidate.Validate(); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	scopedOriginChange := s.credential.ScopedPrivateTrust != nil &&
		candidate.ServerURL != s.credential.ScopedPrivateTrust.Origin
	if s.credential.ScopedPrivateTrust != nil &&
		(candidate.ResolvedTrustMode() != config.TrustSystemCA ||
			candidate.ServerCertificateSHA256 != "") {
		writeError(response, http.StatusConflict, "Scoped private trust cannot be combined with another trust mode or legacy fingerprint")
		return
	}
	if candidate.ServerURL == s.configuration.ServerURL &&
		candidate.ServerToken == s.configuration.ServerToken &&
		candidate.ServerTrustMode == s.configuration.ServerTrustMode &&
		candidate.ServerCertificateSHA256 == s.configuration.ServerCertificateSHA256 &&
		candidate.ShareReasoningSummaries == s.configuration.ShareReasoningSummaries {
		writeJSON(response, http.StatusOK, s.state)
		return
	}
	if scopedOriginChange {
		previousCredential := *s.credential
		migratedCredential, err := s.dependencies.MigrateScopedPrivateTrust(
			request.Context(), previousCredential, candidate.ServerURL,
		)
		if err != nil {
			writeError(response, http.StatusConflict, publicError(err))
			return
		}
		if err := s.dependencies.ReplaceCredential(
			candidate.DataDir, previousCredential, migratedCredential,
		); err != nil {
			writeError(response, http.StatusInternalServerError, publicError(err))
			return
		}
		if err := s.dependencies.ReplaceConfig(s.options.ConfigPath, candidate); err != nil {
			rollbackErr := s.dependencies.ReplaceCredential(
				candidate.DataDir, migratedCredential, previousCredential,
			)
			writeError(response, http.StatusInternalServerError, publicError(errors.Join(err, rollbackErr)))
			return
		}
		s.credential = &migratedCredential
		if err := s.applyReplacedConfigurationLocked(candidate); err != nil {
			writeError(response, http.StatusInternalServerError, publicError(err))
			return
		}
		writeJSON(response, http.StatusOK, s.state)
		return
	}
	if err := s.replaceConfigurationLocked(candidate); err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	writeJSON(response, http.StatusOK, s.state)
}

func (s *Service) updateAgentProvisioning(response http.ResponseWriter, request *http.Request) {
	var input AgentProvisioningInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	settings, err := provisioning.NewSettings(input.Mode, strings.TrimSpace(input.FixedCode))
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	if err := s.requireConfigurationMutationLocked(); err != nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	candidate := cloneConfiguration(*s.configuration)
	candidate.AgentProvisioning = settings
	if err := candidate.Validate(); err != nil {
		s.mu.Unlock()
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.replaceConfigurationLocked(candidate); err != nil {
		s.mu.Unlock()
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	s.provisioningAuthorizer.Reset()
	s.recordEventLocked("agent_provisioning.changed", "", string(candidate.ResolvedAgentProvisioningMode()))
	s.mu.Unlock()
	writeJSON(response, http.StatusOK, s.State())
}

func (s *Service) updateConfig(response http.ResponseWriter, request *http.Request) {
	var input EnrollmentInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.requireConfigurationMutationLocked(); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	configuration, err := buildConfig(input, s.configuration.DataDir)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if configuration.ServerToken == "" {
		configuration.ServerToken = s.configuration.ServerToken
	}
	configuration.AgentProvisioning = s.configuration.AgentProvisioning
	configuration.ShareReasoningSummaries = reasoningConsentForUpdate(
		*s.configuration, configuration.ServerURL, input.ShareReasoningSummaries,
	)
	if err := s.requireReasoningConsentChangeLocked(configuration); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	if err := s.replaceConfigurationLocked(configuration); err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	writeJSON(response, http.StatusOK, s.state)
}

func buildConfig(input EnrollmentInput, dataDir string) (config.Config, error) {
	configuration := config.Config{
		SchemaVersion:           config.CurrentSchemaVersion,
		ServerURL:               strings.TrimSpace(input.ServerURL),
		ServerToken:             strings.TrimSpace(input.ServerToken),
		ServerTrustMode:         input.ServerTrustMode,
		ServerCertificateSHA256: strings.TrimSpace(input.ServerCertificateSHA256),
		ShareReasoningSummaries: input.ShareReasoningSummaries != nil && *input.ShareReasoningSummaries,
		DeviceName:              strings.TrimSpace(input.DeviceName),
		DataDir:                 dataDir,
		Agents:                  []config.AgentConfig{},
	}
	for _, runtime := range input.Runtimes {
		if !runtime.Enabled {
			continue
		}
		agent, err := buildRuntime(runtime)
		if err != nil {
			return config.Config{}, err
		}
		configuration.Agents = append(configuration.Agents, agent)
	}
	if err := configuration.Validate(); err != nil {
		return config.Config{}, err
	}
	return configuration, nil
}

func buildRuntime(runtime RuntimeInput) (config.AgentConfig, error) {
	runtime.Kind = strings.TrimSpace(runtime.Kind)
	executablePath, err := executableFile(runtime.ExecutablePath)
	if err != nil {
		return config.AgentConfig{}, fmt.Errorf("%s executable: %w", runtime.Kind, err)
	}
	workspace, err := existingDirectory(runtime.Workspace)
	if err != nil {
		return config.AgentConfig{}, fmt.Errorf("%s workspace: %w", runtime.Kind, err)
	}
	agent := config.AgentConfig{
		Name:           strings.TrimSpace(runtime.Name),
		Role:           strings.TrimSpace(runtime.Role),
		Workspace:      workspace,
		WorkspaceAlias: strings.TrimSpace(runtime.WorkspaceAlias),
		RuntimeKind:    runtime.Kind,
		PresetVersion:  config.CurrentPresetVersion,
	}
	if agent.WorkspaceAlias == "" {
		agent.WorkspaceAlias = config.DefaultWorkspaceAlias(workspace)
	}
	if err := config.ValidateWorkspaceAlias(agent.WorkspaceAlias); err != nil {
		return config.AgentConfig{}, err
	}
	switch runtime.Kind {
	case "codex":
		sandbox := runtime.Sandbox
		if sandbox == "" {
			sandbox = "workspace-write"
		}
		if sandbox != "read-only" && sandbox != "workspace-write" {
			return config.AgentConfig{}, fmt.Errorf("Codex sandbox must be read-only or workspace-write")
		}
		agent.Adapter = "codex"
		agent.Command = config.CodexPresetCommand(executablePath)
		agent.Sandbox = sandbox
		agent.CodexSessionConflictPolicy = runtime.CodexSessionConflictPolicy
		if agent.CodexSessionConflictPolicy == "" {
			agent.CodexSessionConflictPolicy = config.CodexSessionConflictPreserveAndRetry
		}
		agent.EnvAllowlist = []string{"HOME", "PATH", "CODEX_HOME"}
	case "pi":
		agent.Adapter = "generic"
		agent.Command = config.PiPresetCommand(executablePath)
		agent.EnvAllowlist = []string{"HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY"}
		credentialName := strings.TrimSpace(runtime.CredentialEnvironmentVar)
		if credentialName != "" {
			if !environmentName.MatchString(credentialName) {
				return config.AgentConfig{}, fmt.Errorf("Pi credential environment variable name is invalid")
			}
			agent.EnvAllowlist = appendUnique(agent.EnvAllowlist, credentialName)
		}
	default:
		return config.AgentConfig{}, fmt.Errorf("Runtime kind must be codex or pi")
	}
	return agent, nil
}

func (s *Service) applyConfigView(configuration config.Config) error {
	identities, err := identity.LoadOrCreate(configuration.DataDir, configuration.Agents)
	if err != nil {
		return fmt.Errorf("load Agent identities: %w", err)
	}
	s.state.ServerURL = configuration.ServerURL
	s.state.ServerTokenConfigured = configuration.ServerToken != ""
	s.state.ShareReasoningSummaries = configuration.ShareReasoningSummaries
	s.state.ServerTrustMode = configuration.ResolvedTrustMode()
	s.state.ServerCertificateSHA256 = configuration.ServerCertificateSHA256
	s.state.ActiveServerTrustMode = string(configuration.ResolvedTrustMode())
	s.state.ServerTrustEpoch = 0
	s.state.ServerCADigestPrefix = ""
	if s.credential != nil {
		s.applyCredentialTrustViewLocked(*s.credential)
	}
	s.state.DeviceName = configuration.DeviceName
	s.state.AgentProvisioning = agentProvisioningView(
		configuration.AgentProvisioning,
		time.Now(),
	)
	s.state.Agents = make([]AgentView, 0, len(configuration.Agents))
	for _, agent := range configuration.Agents {
		kind := agent.RuntimeKind
		if kind == "" {
			kind = "generic"
		}
		sandbox := agent.Sandbox
		executablePath := ""
		if len(agent.Command) > 0 {
			executablePath = agent.Command[0]
		}
		credentialEnvironmentVar := ""
		if kind == "pi" {
			standard := map[string]struct{}{
				"HOME": {}, "PATH": {}, "PI_CODING_AGENT_DIR": {}, "PI_TELEMETRY": {},
			}
			for _, name := range agent.EnvAllowlist {
				if _, exists := standard[name]; !exists {
					credentialEnvironmentVar = name
					break
				}
			}
		}
		executableReady := executableAvailable(executablePath)
		runtimeState := "unavailable"
		if executableReady {
			runtimeState = string(operations.RuntimeIdle)
		}
		s.state.Agents = append(s.state.Agents, AgentView{
			AgentID: identities[agent.Name], Kind: kind, Name: agent.Name, Role: agent.Role,
			ExecutablePath: executablePath, Workspace: agent.Workspace,
			WorkspaceAlias:            agent.ResolvedWorkspaceAlias(),
			WorkspaceFilesystemPolicy: agent.WorkspaceFilesystemPolicy(),
			WorkspaceNetworkPolicy:    agent.WorkspaceNetworkPolicy(),
			Sandbox:                   sandbox, CodexSessionConflictPolicy: agent.CodexSessionConflictPolicy,
			CredentialEnvironmentVar: credentialEnvironmentVar,
			ExecutableReady:          executableReady, RuntimeState: runtimeState,
		})
	}
	return nil
}

func (s *Service) applyCredentialTrustViewLocked(credential pairing.Credential) {
	if credential.ScopedPrivateTrust == nil {
		return
	}
	s.state.ActiveServerTrustMode = credential.ScopedPrivateTrust.Mode
	s.state.ServerTrustEpoch = credential.ScopedPrivateTrust.TrustEpoch
	digest := credential.ScopedPrivateTrust.CACertificateSHA256
	if len(digest) > 12 {
		digest = digest[:12]
	}
	s.state.ServerCADigestPrefix = digest
}

func agentProvisioningView(
	settings config.AgentProvisioningConfig,
	now time.Time,
) AgentProvisioningView {
	mode := settings.Mode
	if mode == "" {
		mode = config.AgentProvisioningDisabled
	}
	view := AgentProvisioningView{
		Mode:                mode,
		FixedCodeConfigured: mode == config.AgentProvisioningFixed && settings.FixedCodeHash != "",
	}
	if mode == config.AgentProvisioningRotating {
		code, rotatesAt, err := provisioning.CurrentCode(settings, now)
		if err == nil {
			view.RotatingCode = code
			view.RotatesAt = rotatesAt.Format(time.RFC3339Nano)
		}
	}
	return view
}

func (s *Service) operationalObserver(epoch uint64) operations.Observer {
	return operations.Observer{
		OnConnection: func(event operations.ConnectionEvent) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.bridgeEpoch != epoch {
				return
			}
			s.state.Connection.State = event.State
			s.state.Connection.Attempt = event.Attempt
			s.state.Connection.NextRetryAt = formatTime(event.NextRetryAt)
			s.state.Connection.LastError = redactOperationalText(event.Error)
			s.recordEventLocked("connection."+string(event.State), event.Error, string(event.State))
			switch event.State {
			case operations.ConnectionOnline:
				s.state.Connection.LastConnectedAt = event.At.Format(time.RFC3339Nano)
				s.state.Connection.LastError = ""
			case operations.ConnectionRetrying:
				s.state.Connection.LastDisconnectedAt = event.At.Format(time.RFC3339Nano)
			}
		},
		OnRuntime: func(event operations.RuntimeEvent) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.bridgeEpoch != epoch {
				return
			}
			for index := range s.state.Agents {
				agent := &s.state.Agents[index]
				if agent.Name != event.AgentName {
					continue
				}
				agent.ActiveRuns += event.ActiveDelta
				if agent.ActiveRuns < 0 {
					agent.ActiveRuns = 0
				}
				if agent.ActiveRuns > 0 {
					agent.RuntimeState = string(operations.RuntimeWorking)
				} else {
					agent.RuntimeState = string(event.State)
				}
				agent.LastRunStatus = event.LastStatus
				agent.LastRuntimeError = event.ErrorCode
				agent.LastRunAt = event.At.Format(time.RFC3339Nano)
				s.recordEventLocked("runtime."+string(event.State), event.ErrorCode, event.LastStatus)
				break
			}
		},
	}
}

func formatTime(value *time.Time) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func executableAvailable(path string) bool {
	return executableAvailableForPlatform(path, runtime.GOOS)
}

func executableAvailableForPlatform(path, platform string) bool {
	return launchable.File(path, platform)
}

func redactOperationalText(value string) string {
	return diagnostics.Sanitize(value)
}

func (s *Service) recordEventLocked(eventType, message, state string) {
	event := diagnostics.Event{
		At: time.Now().UTC().Format(time.RFC3339Nano), Type: diagnostics.Sanitize(eventType),
		State: diagnostics.Sanitize(state), Message: diagnostics.Sanitize(message),
	}
	s.events = append(s.events, event)
	if len(s.events) > 100 {
		s.events = append([]diagnostics.Event{}, s.events[len(s.events)-100:]...)
	}
}

func (s *Service) diagnosticInputLocked() diagnostics.Input {
	agents := make([]diagnostics.Agent, 0, len(s.state.Agents))
	for _, agent := range s.state.Agents {
		executableReady := executableAvailable(agent.ExecutablePath)
		runtimeState := agent.RuntimeState
		if agent.ActiveRuns == 0 && !executableReady {
			runtimeState = "unavailable"
		}
		agents = append(agents, diagnostics.Agent{
			Kind: agent.Kind, ExecutableReady: executableReady,
			RuntimeState: runtimeState, ActiveRuns: agent.ActiveRuns,
			LastRunStatus: agent.LastRunStatus, LastRuntimeError: agent.LastRuntimeError,
			LastRunAt: agent.LastRunAt,
		})
	}
	return diagnostics.Input{
		Version: s.state.Version, Configured: s.state.Configured, Paired: s.state.Paired,
		BridgeRunning:         s.state.BridgeRunning,
		ActiveServerTrustMode: s.state.ActiveServerTrustMode,
		ServerTrustEpoch:      s.state.ServerTrustEpoch,
		ServerCADigestPrefix:  s.state.ServerCADigestPrefix,
		Connection: diagnostics.Connection{
			State: string(s.state.Connection.State), Attempt: s.state.Connection.Attempt,
			LastConnectedAt:    s.state.Connection.LastConnectedAt,
			LastDisconnectedAt: s.state.Connection.LastDisconnectedAt,
			NextRetryAt:        s.state.Connection.NextRetryAt,
			LastError:          s.state.Connection.LastError,
		},
		Agents:                agents,
		LoginStartupSupported: s.state.LoginStartup.Supported,
		LoginStartupEnabled:   s.state.LoginStartup.Enabled,
		Events:                append([]diagnostics.Event{}, s.events...),
	}
}

func cloneState(state State) State {
	state.Agents = append([]AgentView{}, state.Agents...)
	discovered := make(map[string]RuntimeDiscovery, len(state.RuntimeDiscovery))
	for kind, value := range state.RuntimeDiscovery {
		discovered[kind] = value
	}
	state.RuntimeDiscovery = discovered
	return state
}

func phaseFor(configured, running bool) Phase {
	if running {
		return PhaseRunning
	}
	if configured {
		return PhaseReady
	}
	return PhaseUnconfigured
}

func randomToken() (string, error) {
	source := make([]byte, 32)
	if _, err := rand.Read(source); err != nil {
		return "", fmt.Errorf("generate Console token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(source), nil
}

func executableFile(value string) (string, error) {
	return executableFileForPlatform(value, runtime.GOOS)
}

func executableFileForPlatform(value, platform string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("path is required")
	}
	resolved, err := filepath.Abs(trimmed)
	if err != nil {
		return "", err
	}
	if !launchable.File(resolved, platform) {
		return "", fmt.Errorf("path must identify an executable file")
	}
	return resolved, nil
}

func existingDirectory(value string) (string, error) {
	resolved, err := filepath.Abs(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("path must identify an existing directory")
	}
	return resolved, nil
}

func appendUnique(values []string, value string) []string {
	for _, current := range values {
		if current == value {
			return values
		}
	}
	return append(values, value)
}

func decodeJSON(request *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(request.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("JSON body must contain one value")
	}
	return nil
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("content-type", "application/json; charset=utf-8")
	response.Header().Set("cache-control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		response.Header().Set("referrer-policy", "no-referrer")
		response.Header().Set("x-content-type-options", "nosniff")
		response.Header().Set("x-frame-options", "DENY")
		next.ServeHTTP(response, request)
	})
}

func publicError(err error) string {
	if errors.Is(err, context.Canceled) {
		return "Operation canceled"
	}
	return err.Error()
}

func rootError(err error) error {
	for err != nil {
		unwrapped := errors.Unwrap(err)
		if unwrapped == nil {
			return err
		}
		err = unwrapped
	}
	return nil
}
