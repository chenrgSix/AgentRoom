package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	SchemaVersion           int           `json:"schemaVersion"`
	ServerURL               string        `json:"serverUrl"`
	ServerTrustMode         TrustMode     `json:"serverTrustMode,omitempty"`
	ServerCertificateSHA256 string        `json:"serverCertificateSha256,omitempty"`
	DeviceName              string        `json:"deviceName"`
	DataDir                 string        `json:"dataDir"`
	Agents                  []AgentConfig `json:"agents"`
}

type TrustMode string

const (
	TrustSystemCA     TrustMode = "system_ca"
	TrustPinnedSHA256 TrustMode = "pinned_sha256"
)

// ResolvedTrustMode keeps existing fingerprint-only configurations working
// while making system CA validation the default for new public HTTPS servers.
func (c Config) ResolvedTrustMode() TrustMode {
	if c.ServerTrustMode != "" {
		return c.ServerTrustMode
	}
	if strings.TrimSpace(c.ServerCertificateSHA256) != "" {
		return TrustPinnedSHA256
	}
	return TrustSystemCA
}

type AgentConfig struct {
	Name          string   `json:"name"`
	Role          string   `json:"role"`
	Adapter       string   `json:"adapter"`
	RuntimeKind   string   `json:"runtimeKind"`
	PresetVersion int      `json:"presetVersion"`
	Command       []string `json:"command"`
	Workspace     string   `json:"workspace"`
	EnvAllowlist  []string `json:"envAllowlist,omitempty"`
}

const (
	CurrentSchemaVersion = 1
	CurrentPresetVersion = 1
)

func CodexPresetCommand(executable, sandbox string) []string {
	if sandbox != "read-only" && sandbox != "workspace-write" {
		sandbox = "workspace-write"
	}
	return []string{executable, "exec", "--json", "--sandbox", sandbox, "-"}
}

func PiPresetCommand(executable string) []string {
	return []string{
		executable, "--print", "--no-tools", "--no-extensions", "--no-skills",
		"--no-context-files", "--no-session",
	}
}

func DefaultPath() string {
	directory, err := os.UserConfigDir()
	if err != nil {
		return "bridge.json"
	}
	return filepath.Join(directory, "agentroom", "bridge.json")
}

func Load(path string) (Config, error) {
	source, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(source)))
	decoder.DisallowUnknownFields()
	var value Config
	if err := decoder.Decode(&value); err != nil {
		return Config{}, fmt.Errorf("decode config: %w", err)
	}
	value, err = Migrate(value)
	if err != nil {
		return Config{}, err
	}
	if !filepath.IsAbs(value.DataDir) {
		value.DataDir = filepath.Join(filepath.Dir(path), value.DataDir)
	}
	if err := value.Validate(); err != nil {
		return Config{}, err
	}
	return value, nil
}

func Save(path string, value Config) error {
	var err error
	value, err = Migrate(value)
	if err != nil {
		return err
	}
	if err := value.Validate(); err != nil {
		return err
	}
	resolved, err := EnsureAvailable(path)
	if err != nil {
		return err
	}
	return writeAtomic(resolved, value)
}

func Replace(path string, value Config) error {
	var err error
	value, err = Migrate(value)
	if err != nil {
		return err
	}
	if err := value.Validate(); err != nil {
		return err
	}
	resolved, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve config path: %w", err)
	}
	info, err := os.Lstat(resolved)
	if err != nil {
		return fmt.Errorf("inspect config path: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("config path identifies a directory")
	}
	return writeAtomic(resolved, value)
}

// Migrate upgrades owner-authored configuration in memory. Loading never
// rewrites the file; the next explicit save persists current version markers.
func Migrate(value Config) (Config, error) {
	if value.SchemaVersion < 0 || value.SchemaVersion > CurrentSchemaVersion {
		return Config{}, fmt.Errorf("unsupported config schemaVersion %d", value.SchemaVersion)
	}
	value.SchemaVersion = CurrentSchemaVersion
	for index := range value.Agents {
		agent := &value.Agents[index]
		if agent.PresetVersion < 0 || agent.PresetVersion > CurrentPresetVersion {
			return Config{}, fmt.Errorf(
				"agents[%d]: unsupported presetVersion %d", index, agent.PresetVersion,
			)
		}
		if agent.RuntimeKind == "" {
			switch {
			case agent.Adapter == "codex":
				agent.RuntimeKind = "codex"
			case legacyPiCommand(agent.Command):
				agent.RuntimeKind = "pi"
			default:
				agent.RuntimeKind = "generic"
			}
		}
		if agent.PresetVersion != 0 {
			continue
		}
		switch agent.RuntimeKind {
		case "codex":
			if len(agent.Command) > 0 {
				agent.Command = CodexPresetCommand(agent.Command[0], codexSandbox(agent.Command))
			}
			agent.PresetVersion = CurrentPresetVersion
		case "pi":
			if len(agent.Command) > 0 {
				agent.Command = PiPresetCommand(agent.Command[0])
			}
			agent.PresetVersion = CurrentPresetVersion
		case "generic":
			// Owner-authored Generic commands are not managed presets.
		default:
			return Config{}, fmt.Errorf("agents[%d]: unsupported runtimeKind %q", index, agent.RuntimeKind)
		}
	}
	return value, nil
}

func legacyPiCommand(command []string) bool {
	if len(command) == 0 {
		return false
	}
	name := strings.ToLower(filepath.Base(command[0]))
	return name == "pi" || name == "pi.exe" || name == "pi.cmd"
}

func codexSandbox(command []string) string {
	for index, argument := range command {
		if argument == "--sandbox" && index+1 < len(command) {
			return command[index+1]
		}
	}
	return "workspace-write"
}

func writeAtomic(resolved string, value Config) error {
	if err := os.MkdirAll(filepath.Dir(resolved), 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	source, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(resolved), ".bridge-config-*")
	if err != nil {
		return fmt.Errorf("create temporary config: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(source, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, resolved); err != nil {
		return fmt.Errorf("install config: %w", err)
	}
	return nil
}

func EnsureAvailable(path string) (string, error) {
	resolved, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve config path: %w", err)
	}
	if _, err := os.Stat(resolved); err == nil {
		return "", fmt.Errorf("config already exists at %s", resolved)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect config path: %w", err)
	}
	return resolved, nil
}

func (c Config) Validate() error {
	if c.SchemaVersion != 0 && c.SchemaVersion != CurrentSchemaVersion {
		return fmt.Errorf("schemaVersion must be %d", CurrentSchemaVersion)
	}
	parsed, err := url.Parse(c.ServerURL)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("serverUrl must be an absolute URL")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return fmt.Errorf("serverUrl must use HTTPS except on loopback")
	}
	trustMode := c.ResolvedTrustMode()
	if trustMode != TrustSystemCA && trustMode != TrustPinnedSHA256 {
		return fmt.Errorf("serverTrustMode must be system_ca or pinned_sha256")
	}
	if parsed.Scheme != "https" {
		if c.ServerTrustMode == TrustPinnedSHA256 || strings.TrimSpace(c.ServerCertificateSHA256) != "" {
			return fmt.Errorf("certificate pinning requires HTTPS")
		}
	} else if trustMode == TrustSystemCA {
		if strings.TrimSpace(c.ServerCertificateSHA256) != "" {
			return fmt.Errorf("system_ca cannot be combined with serverCertificateSha256")
		}
	} else {
		fingerprint := strings.ToLower(strings.ReplaceAll(c.ServerCertificateSHA256, ":", ""))
		if len(fingerprint) != 64 {
			return fmt.Errorf("serverCertificateSha256 must contain a SHA-256 fingerprint")
		}
		for _, character := range fingerprint {
			if !strings.ContainsRune("0123456789abcdef", character) {
				return fmt.Errorf("serverCertificateSha256 must be hexadecimal")
			}
		}
	}
	if strings.TrimSpace(c.DeviceName) == "" || len(c.DeviceName) > 80 {
		return fmt.Errorf("deviceName must contain 1 to 80 characters")
	}
	if !filepath.IsAbs(c.DataDir) {
		return fmt.Errorf("dataDir must resolve to an absolute path")
	}
	if len(c.Agents) == 0 {
		return fmt.Errorf("at least one Agent configuration is required")
	}
	names := make(map[string]struct{}, len(c.Agents))
	for index, agent := range c.Agents {
		if err := agent.validate(); err != nil {
			return fmt.Errorf("agents[%d]: %w", index, err)
		}
		if _, exists := names[agent.Name]; exists {
			return fmt.Errorf("duplicate Agent name %q", agent.Name)
		}
		names[agent.Name] = struct{}{}
	}
	return nil
}

func (a AgentConfig) validate() error {
	if strings.TrimSpace(a.Name) == "" || len(a.Name) > 80 {
		return fmt.Errorf("name must contain 1 to 80 characters")
	}
	if strings.TrimSpace(a.Role) == "" || len(a.Role) > 80 {
		return fmt.Errorf("role must contain 1 to 80 characters")
	}
	if a.Adapter != "codex" && a.Adapter != "generic" {
		return fmt.Errorf("adapter must be codex or generic")
	}
	if a.RuntimeKind != "" && a.RuntimeKind != "codex" &&
		a.RuntimeKind != "pi" && a.RuntimeKind != "generic" {
		return fmt.Errorf("runtimeKind must be codex, pi, or generic")
	}
	if a.RuntimeKind == "codex" && a.Adapter != "codex" {
		return fmt.Errorf("codex runtimeKind requires the codex adapter")
	}
	if (a.RuntimeKind == "pi" || a.RuntimeKind == "generic") && a.Adapter != "generic" {
		return fmt.Errorf("pi and generic runtimeKind require the generic adapter")
	}
	if a.PresetVersion < 0 || a.PresetVersion > CurrentPresetVersion {
		return fmt.Errorf("presetVersion must be between 0 and %d", CurrentPresetVersion)
	}
	if len(a.Command) == 0 || strings.TrimSpace(a.Command[0]) == "" {
		return fmt.Errorf("command must be a non-empty argument array")
	}
	if !filepath.IsAbs(a.Workspace) {
		return fmt.Errorf("workspace must be an absolute path")
	}
	for _, name := range a.EnvAllowlist {
		if name == "" || strings.Contains(name, "=") {
			return fmt.Errorf("envAllowlist contains an invalid variable name")
		}
	}
	return nil
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
