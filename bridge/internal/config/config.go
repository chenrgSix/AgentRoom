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
	ServerURL               string        `json:"serverUrl"`
	ServerCertificateSHA256 string        `json:"serverCertificateSha256,omitempty"`
	DeviceName              string        `json:"deviceName"`
	DataDir                 string        `json:"dataDir"`
	Agents                  []AgentConfig `json:"agents"`
}

type AgentConfig struct {
	Name         string   `json:"name"`
	Role         string   `json:"role"`
	Adapter      string   `json:"adapter"`
	Command      []string `json:"command"`
	Workspace    string   `json:"workspace"`
	EnvAllowlist []string `json:"envAllowlist,omitempty"`
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
	if !filepath.IsAbs(value.DataDir) {
		value.DataDir = filepath.Join(filepath.Dir(path), value.DataDir)
	}
	if err := value.Validate(); err != nil {
		return Config{}, err
	}
	return value, nil
}

func Save(path string, value Config) error {
	if err := value.Validate(); err != nil {
		return err
	}
	resolved, err := EnsureAvailable(path)
	if err != nil {
		return err
	}
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
	parsed, err := url.Parse(c.ServerURL)
	if err != nil || parsed.Host == "" {
		return fmt.Errorf("serverUrl must be an absolute URL")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return fmt.Errorf("serverUrl must use HTTPS except on loopback")
	}
	if parsed.Scheme == "https" {
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
