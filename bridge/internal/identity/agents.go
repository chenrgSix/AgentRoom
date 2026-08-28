package identity

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"convenewire.dev/bridge/internal/config"
)

const filename = "agent-identities.json"

func LoadOrCreate(dataDir string, agents []config.AgentConfig) (map[string]string, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dataDir, filename)
	identities := make(map[string]string)
	if source, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(source, &identities); err != nil {
			return nil, fmt.Errorf("decode Agent identities: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	changed := false
	for _, agent := range agents {
		if identities[agent.Name] == "" {
			identities[agent.Name] = newID("agent")
			changed = true
		}
	}
	if changed {
		if err := save(path, identities); err != nil {
			return nil, err
		}
	}
	return identities, nil
}

// BindName associates a configured display name with an existing immutable
// Agent identity. The old name may remain as a harmless alias so a failed
// configuration replacement cannot orphan the original identity.
func BindName(dataDir, name, agentID string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dataDir, filename)
	identities := make(map[string]string)
	if source, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(source, &identities); err != nil {
			return fmt.Errorf("decode Agent identities: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if existing := identities[name]; existing != "" && existing != agentID {
		return fmt.Errorf("Agent name %q already has a different identity", name)
	}
	if identities[name] == agentID {
		return nil
	}
	identities[name] = agentID
	return save(path, identities)
}

func save(path string, identities map[string]string) error {
	source, err := json.MarshalIndent(identities, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agents-*")
	if err != nil {
		return err
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
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func newID(prefix string) string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(buffer)
}
