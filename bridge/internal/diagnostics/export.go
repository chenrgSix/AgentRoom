package diagnostics

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	SchemaVersion  = "1.0"
	maxEvents      = 100
	maxAgents      = 50
	maxTextLength  = 512
	defaultDirName = "Downloads"
)

type Connection struct {
	State              string `json:"state"`
	Attempt            int    `json:"attempt"`
	LastConnectedAt    string `json:"lastConnectedAt,omitempty"`
	LastDisconnectedAt string `json:"lastDisconnectedAt,omitempty"`
	NextRetryAt        string `json:"nextRetryAt,omitempty"`
	LastError          string `json:"lastError,omitempty"`
}

type Agent struct {
	Kind             string `json:"kind"`
	ExecutableReady  bool   `json:"executableReady"`
	RuntimeState     string `json:"runtimeState"`
	ActiveRuns       int    `json:"activeRuns"`
	LastRunStatus    string `json:"lastRunStatus,omitempty"`
	LastRuntimeError string `json:"lastRuntimeError,omitempty"`
	LastRunAt        string `json:"lastRunAt,omitempty"`
}

type Event struct {
	At      string `json:"at"`
	Type    string `json:"type"`
	State   string `json:"state,omitempty"`
	Message string `json:"message,omitempty"`
}

type Input struct {
	Version               string
	Configured            bool
	Paired                bool
	BridgeRunning         bool
	ActiveServerTrustMode string
	ServerTrustEpoch      int64
	ServerCADigestPrefix  string
	Connection            Connection
	Agents                []Agent
	LoginStartupSupported bool
	LoginStartupEnabled   bool
	Events                []Event
	Now                   time.Time
}

type Result struct {
	Path     string `json:"-"`
	Filename string `json:"filename"`
	SHA256   string `json:"sha256"`
}

type manifest struct {
	SchemaVersion string `json:"schemaVersion"`
	GeneratedAt   string `json:"generatedAt"`
	BridgeVersion string `json:"bridgeVersion"`
	OS            string `json:"os"`
	Architecture  string `json:"architecture"`
}

type status struct {
	Configured          bool       `json:"configured"`
	Paired              bool       `json:"paired"`
	BridgeRunning       bool       `json:"bridgeRunning"`
	ActiveTrustMode     string     `json:"activeTrustMode,omitempty"`
	TrustEpoch          int64      `json:"trustEpoch,omitempty"`
	CADigestPrefix      string     `json:"caDigestPrefix,omitempty"`
	Connection          Connection `json:"connection"`
	Agents              []Agent    `json:"agents"`
	LoginStartupSupport bool       `json:"loginStartupSupported"`
	LoginStartupEnabled bool       `json:"loginStartupEnabled"`
}

var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/=-]{8,}`),
	regexp.MustCompile(`sk-[A-Za-z0-9_-]{12,}`),
	regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{16,}`),
	regexp.MustCompile(`AKIA[0-9A-Z]{16}`),
	regexp.MustCompile(`(?i)(password|secret|token)\s*[=:]\s*[^\s,;]{6,}`),
	regexp.MustCompile(`(?i)(?:device|team|agent|run|trace)_[A-Za-z0-9_-]{6,}`),
	regexp.MustCompile(`(?:/Users|/home|/private|/tmp|/var|/opt|/Applications)/[^\s"'<>]+`),
	regexp.MustCompile(`[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'<>]+`),
}

func DefaultDirectory() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, defaultDirName)
}

func Export(directory string, input Input) (Result, error) {
	if directory == "" {
		directory = DefaultDirectory()
	}
	resolved, err := filepath.Abs(directory)
	if err != nil {
		return Result{}, fmt.Errorf("resolve diagnostics directory: %w", err)
	}
	if err := os.MkdirAll(resolved, 0o700); err != nil {
		return Result{}, fmt.Errorf("create diagnostics directory: %w", err)
	}
	now := input.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	file, path, err := createExclusive(resolved, now)
	if err != nil {
		return Result{}, err
	}
	complete := false
	defer func() {
		file.Close()
		if !complete {
			_ = os.Remove(path)
		}
	}()

	// Raw connection errors are useful locally but may include server URLs,
	// subprocess text, or prompt fragments. The export keeps state/timestamps
	// and omits the message entirely.
	input.Connection.LastError = ""
	agents := append([]Agent{}, input.Agents...)
	if len(agents) > maxAgents {
		agents = agents[:maxAgents]
	}
	for index := range agents {
		agents[index].LastRuntimeError = Sanitize(agents[index].LastRuntimeError)
	}
	events := append([]Event{}, input.Events...)
	if len(events) > maxEvents {
		events = events[len(events)-maxEvents:]
	}
	for index := range events {
		events[index].Type = Sanitize(events[index].Type)
		events[index].State = Sanitize(events[index].State)
		// Event messages are deliberately omitted. Even a locally generated error
		// may embed a Runtime prompt or path supplied by a subprocess.
		events[index].Message = ""
	}

	archive := zip.NewWriter(file)
	entries := []struct {
		name  string
		value any
	}{
		{"manifest.json", manifest{
			SchemaVersion: SchemaVersion, GeneratedAt: now.Format(time.RFC3339Nano),
			BridgeVersion: Sanitize(input.Version), OS: runtime.GOOS, Architecture: runtime.GOARCH,
		}},
		{"status.json", status{
			Configured: input.Configured, Paired: input.Paired, BridgeRunning: input.BridgeRunning,
			ActiveTrustMode: Sanitize(input.ActiveServerTrustMode), TrustEpoch: input.ServerTrustEpoch,
			CADigestPrefix: Sanitize(input.ServerCADigestPrefix),
			Connection:     input.Connection, Agents: agents,
			LoginStartupSupport: input.LoginStartupSupported, LoginStartupEnabled: input.LoginStartupEnabled,
		}},
		{"events.json", events},
	}
	for _, entry := range entries {
		if err := writeJSONEntry(archive, entry.name, entry.value); err != nil {
			archive.Close()
			return Result{}, err
		}
	}
	if err := archive.Close(); err != nil {
		return Result{}, fmt.Errorf("finish diagnostics archive: %w", err)
	}
	if err := file.Sync(); err != nil {
		return Result{}, err
	}
	if err := file.Close(); err != nil {
		return Result{}, err
	}
	source, err := os.ReadFile(path)
	if err != nil {
		return Result{}, err
	}
	digest := sha256.Sum256(source)
	complete = true
	return Result{Path: path, Filename: filepath.Base(path), SHA256: hex.EncodeToString(digest[:])}, nil
}

func Sanitize(value string) string {
	result := value
	for _, pattern := range sensitivePatterns {
		result = pattern.ReplaceAllString(result, "[REDACTED]")
	}
	result = strings.TrimSpace(result)
	if len(result) > maxTextLength {
		result = result[:maxTextLength] + "..."
	}
	return result
}

func createExclusive(directory string, now time.Time) (*os.File, string, error) {
	base := "convenewire-bridge-diagnostics-" + now.Format("20060102T150405Z")
	for index := 0; index < 100; index++ {
		name := base + ".zip"
		if index > 0 {
			name = fmt.Sprintf("%s-%02d.zip", base, index)
		}
		path := filepath.Join(directory, name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			return file, path, nil
		}
		if !os.IsExist(err) {
			return nil, "", err
		}
	}
	return nil, "", fmt.Errorf("too many diagnostics archives share the same timestamp")
}

func writeJSONEntry(archive *zip.Writer, name string, value any) error {
	entry, err := archive.Create(name)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(entry)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	return nil
}
