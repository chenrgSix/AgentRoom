package identity

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/durablefs"
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
	active := make(map[string]string, len(agents))
	for _, agent := range agents {
		if identities[agent.Name] == "" {
			identities[agent.Name] = newID("agent")
			changed = true
		}
		id := identities[agent.Name]
		if name, exists := active[id]; exists {
			return nil, fmt.Errorf("configured Agents %q and %q share an identity; repair the ambiguous roster before starting", name, agent.Name)
		}
		active[id] = agent.Name
	}
	if changed {
		if err := save(path, identities); err != nil {
			return nil, err
		}
	}
	return identities, nil
}

// AllocateNew reserves an identity for explicit creation, not roster recovery.
// A former name may point at another currently configured Agent. Replacing only
// that inactive alias keeps the renamed Agent stable. A failed config save may
// retry this reservation without rotating it. The Console owns serialization.
func AllocateNew(dataDir string, current []config.AgentConfig, name string) (string, error) {
	identities, err := LoadOrCreate(dataDir, current)
	if err != nil {
		return "", err
	}
	reserved := identities[name]
	for _, agent := range current {
		if agent.Name == name {
			return "", fmt.Errorf("Agent name %q is already configured", name)
		}
		if identities[agent.Name] == reserved {
			reserved = ""
		}
	}
	if reserved != "" {
		return reserved, nil
	}
	id := newID("agent")
	identities[name] = id
	if err := save(filepath.Join(dataDir, filename), identities); err != nil {
		return "", err
	}
	return id, nil
}

// BindName associates a configured display name with an existing immutable
// Agent identity. The old name remains a recovery alias so a failed
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
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	return durablefs.SyncParent(path)
}

func newID(prefix string) string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(buffer)
}
