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

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/pairing"
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
	ServerURL               string         `json:"serverUrl"`
	ServerCertificateSHA256 string         `json:"serverCertificateSha256,omitempty"`
	DeviceName              string         `json:"deviceName"`
	Runtimes                []RuntimeInput `json:"runtimes"`
}

type AgentView struct {
	Kind                     string `json:"kind"`
	Name                     string `json:"name"`
	Role                     string `json:"role"`
	ExecutablePath           string `json:"executablePath"`
	Workspace                string `json:"workspace"`
	Sandbox                  string `json:"sandbox,omitempty"`
	CredentialEnvironmentVar string `json:"credentialEnvironmentVariable,omitempty"`
}

type State struct {
	Phase                   Phase       `json:"phase"`
	Configured              bool        `json:"configured"`
	Paired                  bool        `json:"paired"`
	BridgeRunning           bool        `json:"bridgeRunning"`
	ConfigPath              string      `json:"configPath"`
	Workspace               string      `json:"workspace"`
	ServerURL               string      `json:"serverUrl,omitempty"`
	ServerCertificateSHA256 string      `json:"serverCertificateSha256,omitempty"`
	DeviceName              string      `json:"deviceName,omitempty"`
	TeamID                  string      `json:"teamId,omitempty"`
	DeviceID                string      `json:"deviceId,omitempty"`
	JoinCode                string      `json:"joinCode,omitempty"`
	JoinExpiresAt           string      `json:"joinExpiresAt,omitempty"`
	LastError               string      `json:"lastError,omitempty"`
	Agents                  []AgentView `json:"agents"`
	DetectedCodex           string      `json:"detectedCodex,omitempty"`
	DetectedPi              string      `json:"detectedPi,omitempty"`
}

type Dependencies struct {
	Enroll         func(context.Context, config.Config, func(enrollment.Challenge)) (pairing.Credential, error)
	SaveConfig     func(string, config.Config) error
	ReplaceConfig  func(string, config.Config) error
	SaveCredential func(string, pairing.Credential) error
	RunBridge      func(context.Context, config.Config, pairing.Credential) error
}

type Options struct {
	ConfigPath string
	DataDir    string
	Workspace  string
	Token      string
}

type Service struct {
	mu            sync.Mutex
	options       Options
	dependencies  Dependencies
	tokenHash     [32]byte
	token         string
	state         State
	configuration *config.Config
	credential    *pairing.Credential
	joinCancel    context.CancelFunc
	bridgeCancel  context.CancelFunc
	bridgeEpoch   uint64
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
	token := options.Token
	if token == "" {
		token, err = randomToken()
		if err != nil {
			return nil, err
		}
	}
	service := &Service{
		options: Options{
			ConfigPath: resolvedConfig,
			DataDir:    resolvedData,
			Workspace:  workspace,
			Token:      token,
		},
		dependencies: dependencies,
		token:        token,
		tokenHash:    sha256.Sum256([]byte(token)),
		state: State{
			Phase:         PhaseUnconfigured,
			ConfigPath:    resolvedConfig,
			Workspace:     workspace,
			Agents:        []AgentView{},
			DetectedCodex: discover("codex"),
			DetectedPi:    discover("pi"),
		},
	}
	if loaded, loadErr := config.Load(resolvedConfig); loadErr == nil {
		service.configuration = &loaded
		service.state.Configured = true
		service.state.Phase = PhaseReady
		service.applyConfigView(loaded)
		if credential, credentialErr := pairing.Load(loaded.DataDir); credentialErr == nil {
			service.credential = &credential
			service.state.Paired = true
			service.state.TeamID = credential.TeamID
			service.state.DeviceID = credential.DeviceID
		}
	} else if !errors.Is(rootError(loadErr), os.ErrNotExist) {
		return nil, loadErr
	}
	return service, nil
}

func (s *Service) Token() string { return s.token }

func (s *Service) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneState(s.state)
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
	mux.HandleFunc("POST /api/bridge/start", s.authorize(s.startBridge))
	mux.HandleFunc("POST /api/bridge/stop", s.authorize(s.stopBridge))
	mux.Handle("/", securityHeaders(http.FileServer(http.FS(staticRoot))))
	return mux
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
	s.applyConfigView(*configuration)
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
	configuration := *s.configuration
	credential := *s.credential
	go func() {
		err := s.dependencies.RunBridge(ctx, configuration, credential)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.bridgeEpoch != epoch {
			return
		}
		s.bridgeCancel = nil
		s.state.BridgeRunning = false
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
	s.applyConfigView(configuration)
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
		ServerURL:               strings.TrimSpace(input.ServerURL),
		ServerCertificateSHA256: strings.TrimSpace(input.ServerCertificateSHA256),
		DeviceName:              strings.TrimSpace(input.DeviceName),
		DataDir:                 dataDir,
		Agents:                  []config.AgentConfig{},
	}
	for _, runtime := range input.Runtimes {
		if !runtime.Enabled {
			continue
		}
		executablePath, err := executableFile(runtime.ExecutablePath)
		if err != nil {
			return config.Config{}, fmt.Errorf("%s executable: %w", runtime.Kind, err)
		}
		workspace, err := existingDirectory(runtime.Workspace)
		if err != nil {
			return config.Config{}, fmt.Errorf("%s workspace: %w", runtime.Kind, err)
		}
		agent := config.AgentConfig{
			Name:      strings.TrimSpace(runtime.Name),
			Role:      strings.TrimSpace(runtime.Role),
			Workspace: workspace,
		}
		switch runtime.Kind {
		case "codex":
			sandbox := runtime.Sandbox
			if sandbox == "" {
				sandbox = "workspace-write"
			}
			if sandbox != "read-only" && sandbox != "workspace-write" {
				return config.Config{}, fmt.Errorf("Codex sandbox must be read-only or workspace-write")
			}
			agent.Adapter = "codex"
			agent.Command = []string{executablePath, "exec", "--json", "--sandbox", sandbox, "-"}
			agent.EnvAllowlist = []string{"HOME", "PATH", "CODEX_HOME"}
		case "pi":
			agent.Adapter = "generic"
			agent.Command = []string{
				executablePath, "--print", "--no-tools", "--no-extensions", "--no-skills",
				"--no-context-files", "--no-session",
			}
			agent.EnvAllowlist = []string{"HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY"}
			credentialName := strings.TrimSpace(runtime.CredentialEnvironmentVar)
			if credentialName != "" {
				if !environmentName.MatchString(credentialName) {
					return config.Config{}, fmt.Errorf("Pi credential environment variable name is invalid")
				}
				agent.EnvAllowlist = appendUnique(agent.EnvAllowlist, credentialName)
			}
		default:
			return config.Config{}, fmt.Errorf("Runtime kind must be codex or pi")
		}
		configuration.Agents = append(configuration.Agents, agent)
	}
	if err := configuration.Validate(); err != nil {
		return config.Config{}, err
	}
	return configuration, nil
}

func (s *Service) applyConfigView(configuration config.Config) {
	s.state.ServerURL = configuration.ServerURL
	s.state.ServerCertificateSHA256 = configuration.ServerCertificateSHA256
	s.state.DeviceName = configuration.DeviceName
	s.state.Agents = make([]AgentView, 0, len(configuration.Agents))
	for _, agent := range configuration.Agents {
		kind := "pi"
		sandbox := ""
		if agent.Adapter == "codex" {
			kind = "codex"
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
		s.state.Agents = append(s.state.Agents, AgentView{
			Kind: kind, Name: agent.Name, Role: agent.Role,
			ExecutablePath: executablePath, Workspace: agent.Workspace,
			Sandbox: sandbox, CredentialEnvironmentVar: credentialEnvironmentVar,
		})
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
