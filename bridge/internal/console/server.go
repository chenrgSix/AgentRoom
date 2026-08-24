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
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"agentroom.dev/bridge/internal/autostart"
	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/diagnostics"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/identity"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	"agentroom.dev/bridge/internal/updatecheck"
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
	Kind                     string `json:"kind"`
	Enabled                  bool   `json:"enabled"`
	Name                     string `json:"name"`
	Role                     string `json:"role"`
	ExecutablePath           string `json:"executablePath"`
	Workspace                string `json:"workspace"`
	Sandbox                  string `json:"sandbox,omitempty"`
	CredentialEnvironmentVar string `json:"credentialEnvironmentVariable,omitempty"`
}

type EnrollmentInput struct {
	ServerURL               string           `json:"serverUrl"`
	ServerTrustMode         config.TrustMode `json:"serverTrustMode,omitempty"`
	ServerCertificateSHA256 string           `json:"serverCertificateSha256,omitempty"`
	DeviceName              string           `json:"deviceName"`
	Runtimes                []RuntimeInput   `json:"runtimes"`
}

type AgentView struct {
	AgentID                  string `json:"agentId"`
	Kind                     string `json:"kind"`
	Name                     string `json:"name"`
	Role                     string `json:"role"`
	ExecutablePath           string `json:"executablePath"`
	Workspace                string `json:"workspace"`
	Sandbox                  string `json:"sandbox,omitempty"`
	CredentialEnvironmentVar string `json:"credentialEnvironmentVariable,omitempty"`
	ExecutableReady          bool   `json:"executableReady"`
	RuntimeState             string `json:"runtimeState"`
	ActiveRuns               int    `json:"activeRuns"`
	LastRunStatus            string `json:"lastRunStatus,omitempty"`
	LastRuntimeError         string `json:"lastRuntimeError,omitempty"`
	LastRunAt                string `json:"lastRunAt,omitempty"`
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
	Phase                   Phase            `json:"phase"`
	Configured              bool             `json:"configured"`
	Paired                  bool             `json:"paired"`
	BridgeRunning           bool             `json:"bridgeRunning"`
	Version                 string           `json:"version"`
	ConfigPath              string           `json:"configPath"`
	Workspace               string           `json:"workspace"`
	ServerURL               string           `json:"serverUrl,omitempty"`
	ServerTrustMode         config.TrustMode `json:"serverTrustMode,omitempty"`
	ServerCertificateSHA256 string           `json:"serverCertificateSha256,omitempty"`
	DeviceName              string           `json:"deviceName,omitempty"`
	TeamID                  string           `json:"teamId,omitempty"`
	DeviceID                string           `json:"deviceId,omitempty"`
	JoinCode                string           `json:"joinCode,omitempty"`
	JoinExpiresAt           string           `json:"joinExpiresAt,omitempty"`
	LastError               string           `json:"lastError,omitempty"`
	Agents                  []AgentView      `json:"agents"`
	DetectedCodex           string           `json:"detectedCodex,omitempty"`
	DetectedPi              string           `json:"detectedPi,omitempty"`
	Connection              ConnectionView   `json:"connection"`
	LoginStartup            autostart.State  `json:"loginStartup"`
}

type Dependencies struct {
	Enroll         func(context.Context, config.Config, func(enrollment.Challenge)) (pairing.Credential, error)
	SaveConfig     func(string, config.Config) error
	ReplaceConfig  func(string, config.Config) error
	SaveCredential func(string, pairing.Credential) error
	RunBridge      func(context.Context, config.Config, pairing.Credential, operations.Observer) error
	LoginStartup   autostart.Controller
	UpdateChecker  updatecheck.Service
	ProbeRuntime   func(context.Context, config.AgentConfig) RuntimeProbeResult
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
	mu               sync.Mutex
	options          Options
	dependencies     Dependencies
	tokenHash        [32]byte
	token            string
	state            State
	configuration    *config.Config
	credential       *pairing.Credential
	joinCancel       context.CancelFunc
	bridgeCancel     context.CancelFunc
	bridgeEpoch      uint64
	events           []diagnostics.Event
	runtimeTests     map[string]struct{}
	runtimePreflight bool
}

var environmentName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,79}$`)

func New(options Options, dependencies Dependencies) (*Service, error) {
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
			Phase:         PhaseUnconfigured,
			ConfigPath:    resolvedConfig,
			Workspace:     workspace,
			Version:       bridgeVersion,
			Agents:        []AgentView{},
			DetectedCodex: discover("codex"),
			DetectedPi:    discover("pi"),
			Connection:    ConnectionView{State: operations.ConnectionStopped},
		},
		runtimeTests: make(map[string]struct{}),
	}
	if loaded, loadErr := config.Load(resolvedConfig); loadErr == nil {
		service.configuration = &loaded
		service.state.Configured = true
		service.state.Phase = PhaseReady
		if err := service.applyConfigView(loaded); err != nil {
			return nil, err
		}
		if credential, credentialErr := pairing.Load(loaded.DataDir); credentialErr == nil {
			service.credential = &credential
			service.state.Paired = true
			service.state.TeamID = credential.TeamID
			service.state.DeviceID = credential.DeviceID
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
	mux.HandleFunc("POST /api/enrollment/start", s.authorize(s.startEnrollment))
	mux.HandleFunc("POST /api/enrollment/cancel", s.authorize(s.cancelEnrollment))
	mux.HandleFunc("PUT /api/config", s.authorize(s.updateConfig))
	mux.HandleFunc("POST /api/agents", s.authorize(s.addAgent))
	mux.HandleFunc("PUT /api/agents/{agentId}", s.authorize(s.updateAgent))
	mux.HandleFunc("POST /api/runtime-tests", s.authorize(s.testRuntime))
	mux.HandleFunc("POST /api/runtime-preflight", s.authorize(s.preflightRuntime))
	mux.HandleFunc("POST /api/bridge/start", s.authorize(s.startBridge))
	mux.HandleFunc("POST /api/bridge/stop", s.authorize(s.stopBridge))
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
	if request.ContentLength != 0 {
		if err := decodeJSON(request, &input); err != nil {
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
	}
	s.mu.Lock()
	if s.runtimePreflight || len(s.runtimeTests) > 0 {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Wait for the Runtime test to finish before enrollment")
		return
	}
	if s.joinCancel != nil || s.bridgeCancel != nil {
		s.mu.Unlock()
		writeError(response, http.StatusConflict, "Stop the active Bridge or enrollment first")
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
	ctx, cancel := context.WithCancel(context.Background())
	s.joinCancel = cancel
	s.state.Phase = PhaseJoining
	s.state.LastError = ""
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
	if err := s.applyConfigView(*configuration); err != nil {
		s.joinCancel = nil
		s.mu.Unlock()
		cancel()
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	s.mu.Unlock()

	go s.enroll(ctx, *configuration, configuredBefore)
	writeJSON(response, http.StatusAccepted, map[string]string{"status": "joining"})
}

func (s *Service) enroll(ctx context.Context, configuration config.Config, configuredBefore bool) {
	credential, err := s.dependencies.Enroll(ctx, configuration, func(challenge enrollment.Challenge) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.state.Phase = PhaseApproval
		s.state.JoinCode = challenge.UserCode
		s.state.JoinExpiresAt = challenge.ExpiresAt.Format(time.RFC3339Nano)
	})
	if err == nil && !configuredBefore {
		err = s.dependencies.SaveConfig(s.options.ConfigPath, configuration)
	}
	if err == nil {
		err = s.dependencies.SaveCredential(configuration.DataDir, credential)
	}
	s.mu.Lock()
	s.joinCancel = nil
	if errors.Is(err, context.Canceled) {
		s.state.Phase = phaseFor(s.state.Configured, s.state.BridgeRunning)
		s.state.LastError = ""
		s.mu.Unlock()
		return
	}
	if err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
		s.mu.Unlock()
		return
	}
	s.configuration = &configuration
	s.credential = &credential
	s.state.Configured = true
	s.state.Paired = true
	s.state.TeamID = credential.TeamID
	s.state.DeviceID = credential.DeviceID
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
	s.state.Phase = PhaseReady
	err = s.startBridgeLocked()
	if err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
	}
	s.mu.Unlock()
}

func (s *Service) cancelEnrollment(response http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.joinCancel != nil {
		s.joinCancel()
		s.joinCancel = nil
	}
	s.state.JoinCode = ""
	s.state.JoinExpiresAt = ""
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
	s.state.BridgeRunning = true
	s.state.Phase = PhaseRunning
	s.state.LastError = ""
	s.state.Connection = ConnectionView{State: operations.ConnectionConnecting, Attempt: 1}
	s.recordEventLocked("bridge.started", "", string(operations.ConnectionConnecting))
	configuration := *s.configuration
	credential := *s.credential
	go func() {
		err := s.dependencies.RunBridge(ctx, configuration, credential, s.operationalObserver(epoch))
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.bridgeEpoch != epoch {
			return
		}
		s.bridgeCancel = nil
		s.state.BridgeRunning = false
		s.state.Connection.State = operations.ConnectionStopped
		if err != nil && !errors.Is(err, context.Canceled) && ctx.Err() == nil {
			s.state.Phase = PhaseError
			s.state.LastError = publicError(err)
			return
		}
		s.state.Phase = PhaseReady
	}()
	return nil
}

func (s *Service) stopBridge(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, s.StopBridge())
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
	if err := s.requireAgentMutationLocked(); err != nil {
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
	if err := s.requireAgentMutationLocked(); err != nil {
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

func (s *Service) requireAgentMutationLocked() error {
	if s.configuration == nil || s.credential == nil {
		return fmt.Errorf("Complete Team enrollment before editing Agents")
	}
	if s.joinCancel != nil {
		return fmt.Errorf("Wait for Team enrollment to finish before editing Agents")
	}
	if len(s.runtimeTests) > 0 {
		return fmt.Errorf("Wait for Runtime self-tests to finish before editing Agents")
	}
	if s.runtimePreflight {
		return fmt.Errorf("Wait for the Runtime preflight to finish before editing Agents")
	}
	for _, agent := range s.state.Agents {
		if agent.ActiveRuns > 0 {
			return fmt.Errorf("Wait for active Team tasks to finish before editing Agents")
		}
	}
	return nil
}

func (s *Service) replaceConfigurationLocked(configuration config.Config) error {
	if err := s.dependencies.ReplaceConfig(s.options.ConfigPath, configuration); err != nil {
		return err
	}
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

func (s *Service) updateConfig(response http.ResponseWriter, request *http.Request) {
	var input EnrollmentInput
	if err := decodeJSON(request, &input); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	configuration, err := buildConfig(input, s.options.DataDir)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.configuration == nil || s.credential == nil {
		writeError(response, http.StatusConflict, "Complete Team enrollment before editing configuration")
		return
	}
	if err := s.requireAgentMutationLocked(); err != nil {
		writeError(response, http.StatusConflict, err.Error())
		return
	}
	if configuration.ServerURL != s.credential.ServerURL {
		writeError(response, http.StatusConflict, "Paired Bridge server URL cannot be changed; enroll a new Device instead")
		return
	}
	if err := s.dependencies.ReplaceConfig(s.options.ConfigPath, configuration); err != nil {
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	if s.bridgeCancel != nil {
		s.bridgeCancel()
	}
	s.bridgeEpoch++
	s.bridgeCancel = nil
	s.state.BridgeRunning = false
	s.configuration = &configuration
	if err := s.applyConfigView(configuration); err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
		writeError(response, http.StatusInternalServerError, publicError(err))
		return
	}
	if err := s.startBridgeLocked(); err != nil {
		s.state.Phase = PhaseError
		s.state.LastError = publicError(err)
		writeError(response, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, s.state)
}

func buildConfig(input EnrollmentInput, dataDir string) (config.Config, error) {
	configuration := config.Config{
		SchemaVersion:           config.CurrentSchemaVersion,
		ServerURL:               strings.TrimSpace(input.ServerURL),
		ServerTrustMode:         input.ServerTrustMode,
		ServerCertificateSHA256: strings.TrimSpace(input.ServerCertificateSHA256),
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
		Name:          strings.TrimSpace(runtime.Name),
		Role:          strings.TrimSpace(runtime.Role),
		Workspace:     workspace,
		RuntimeKind:   runtime.Kind,
		PresetVersion: config.CurrentPresetVersion,
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
		agent.Command = config.CodexPresetCommand(executablePath, sandbox)
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
	s.state.ServerTrustMode = configuration.ResolvedTrustMode()
	s.state.ServerCertificateSHA256 = configuration.ServerCertificateSHA256
	s.state.DeviceName = configuration.DeviceName
	s.state.Agents = make([]AgentView, 0, len(configuration.Agents))
	for _, agent := range configuration.Agents {
		kind := agent.RuntimeKind
		if kind == "" {
			kind = "generic"
		}
		sandbox := ""
		if kind == "codex" {
			for index, argument := range agent.Command {
				if argument == "--sandbox" && index+1 < len(agent.Command) {
					sandbox = agent.Command[index+1]
				}
			}
		}
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
			Sandbox: sandbox, CredentialEnvironmentVar: credentialEnvironmentVar,
			ExecutableReady: executableReady, RuntimeState: runtimeState,
		})
	}
	return nil
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
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
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
		BridgeRunning: s.state.BridgeRunning,
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

func discover(name string) string {
	value, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	resolved, err := filepath.Abs(value)
	if err != nil {
		return value
	}
	return resolved
}

func executableFile(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("path is required")
	}
	resolved, err := filepath.Abs(trimmed)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || info.IsDir() || info.Mode().Perm()&0o111 == 0 {
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
