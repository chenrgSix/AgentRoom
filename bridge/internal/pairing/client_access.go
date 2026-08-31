package pairing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"convenewire.dev/bridge/internal/durablefs"
)

const clientAccessFilename = "client-member-access.json"

// Kept separate from the Device credential loaded by Runtime/connection code.
type clientAccessFile struct {
	ServerURL string `json:"serverUrl"`
	DeviceID  string `json:"deviceId"`
	TeamID    string `json:"teamId"`
	MemberID  string `json:"memberId"`
	Secret    string `json:"secret"`
}

func saveClientAccess(dataDir string, credential Credential) error {
	if credential.ClientAccessSecret == "" {
		return nil
	}
	if !validPairingSecret(credential.ClientAccessSecret) || credential.ClientAccessSecret == credential.Token {
		return fmt.Errorf("independent client member proof is invalid")
	}
	path := filepath.Join(dataDir, clientAccessFilename)
	if _, err := os.Lstat(path); err == nil || !os.IsNotExist(err) {
		return fmt.Errorf("client member access already exists or cannot be inspected")
	}
	source, err := json.Marshal(clientAccessFile{credential.ServerURL, credential.DeviceID,
		credential.TeamID, credential.OwnerMemberID, credential.ClientAccessSecret})
	if err != nil {
		return fmt.Errorf("encode client member access")
	}
	file, err := os.CreateTemp(dataDir, ".client-member-access-*")
	if err != nil {
		return fmt.Errorf("create client member access")
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return fmt.Errorf("protect client member access")
	}
	if _, err := file.Write(append(source, '\n')); err != nil {
		return fmt.Errorf("write client member access")
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("persist client member access")
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close client member access")
	}
	// Link installs without overwriting a concurrently created credential.
	if err := os.Link(file.Name(), path); err != nil {
		return fmt.Errorf("install client member access")
	}
	return durablefs.SyncParent(path)
}

// LoadClientAccess is used only by explicit, authenticated Console entry actions.
func LoadClientAccess(dataDir string, credential Credential) (string, error) {
	path := filepath.Join(dataDir, clientAccessFilename)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 ||
		(runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return "", fmt.Errorf("client member access is unavailable; confirm ownership with a new pairing")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("client member access is unavailable")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return "", fmt.Errorf("client member access changed while opening")
	}
	source, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(source) > 4096 {
		return "", fmt.Errorf("client member access is invalid")
	}
	var stored clientAccessFile
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		return "", fmt.Errorf("client member access is invalid")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF || stored.ServerURL != credential.ServerURL ||
		stored.DeviceID != credential.DeviceID || stored.TeamID != credential.TeamID ||
		stored.MemberID != credential.OwnerMemberID || !validPairingSecret(stored.Secret) || stored.Secret == credential.Token {
		return "", fmt.Errorf("client member access does not match the current pairing")
	}
	return stored.Secret, nil
}
