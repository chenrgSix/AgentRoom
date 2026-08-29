package pairing

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/durablefs"
)

const credentialFilename = "device-credential.json"

type Credential struct {
	ServerURL          string              `json:"serverUrl"`
	DeviceID           string              `json:"deviceId"`
	TeamID             string              `json:"teamId"`
	OwnerMemberID      string              `json:"ownerMemberId"`
	Token              string              `json:"token"`
	ExpiresAt          *string             `json:"expiresAt"`
	ScopedPrivateTrust *ScopedPrivateTrust `json:"scopedPrivateTrust,omitempty"`
}

type pairResponse struct {
	Device struct {
		DeviceID      string `json:"deviceId"`
		TeamID        string `json:"teamId"`
		OwnerMemberID string `json:"ownerMemberId"`
	} `json:"device"`
	Credential struct {
		Token     string  `json:"token"`
		ExpiresAt *string `json:"expiresAt"`
	} `json:"credential"`
}

func Exchange(ctx context.Context, cfg config.Config, code string) (Credential, error) {
	body, err := json.Marshal(map[string]string{
		"code": code, "deviceName": cfg.DeviceName,
	})
	if err != nil {
		return Credential{}, err
	}
	endpoint := strings.TrimRight(cfg.ServerURL, "/") + "/api/bridge/pair"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Credential{}, err
	}
	request.Header.Set("content-type", "application/json")
	if cfg.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, cfg.ServerToken)
	}
	response, err := HTTPClient(cfg).Do(request)
	if err != nil {
		return Credential{}, fmt.Errorf("pair request: %w", err)
	}
	defer response.Body.Close()
	source, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return Credential{}, fmt.Errorf("read pair response: %w", err)
	}
	if response.StatusCode != http.StatusOK {
		return Credential{}, fmt.Errorf("pair rejected with status %d", response.StatusCode)
	}
	var decoded pairResponse
	if err := json.Unmarshal(source, &decoded); err != nil {
		return Credential{}, fmt.Errorf("decode pair response: %w", err)
	}
	if decoded.Device.DeviceID == "" || decoded.Credential.Token == "" {
		return Credential{}, fmt.Errorf("pair response omitted identity or credential")
	}
	credential := Credential{
		ServerURL:     cfg.ServerURL,
		DeviceID:      decoded.Device.DeviceID,
		TeamID:        decoded.Device.TeamID,
		OwnerMemberID: decoded.Device.OwnerMemberID,
		Token:         decoded.Credential.Token,
		ExpiresAt:     decoded.Credential.ExpiresAt,
	}
	if err := Save(cfg.DataDir, credential); err != nil {
		return Credential{}, err
	}
	return credential, nil
}

func Save(dataDir string, credential Credential) error {
	if err := validateCredentialTrust(credential); err != nil {
		return err
	}
	path, err := EnsureAvailable(dataDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create credential directory: %w", err)
	}
	source, err := json.MarshalIndent(credential, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dataDir, ".credential-*")
	if err != nil {
		return fmt.Errorf("create credential file: %w", err)
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
		return fmt.Errorf("install credential: %w", err)
	}
	return durablefs.SyncParent(path)
}

func Replace(dataDir string, previous Credential, credential Credential) error {
	if err := validateCredentialTrust(credential); err != nil {
		return err
	}
	current, err := Load(dataDir)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(current, previous) {
		return fmt.Errorf("credential changed while updating scoped private trust")
	}
	path := filepath.Join(dataDir, credentialFilename)
	source, err := json.MarshalIndent(credential, "", "  ")
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dataDir, ".credential-rotation-*")
	if err != nil {
		return fmt.Errorf("create credential rotation file: %w", err)
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
		return fmt.Errorf("install credential rotation: %w", err)
	}
	return durablefs.SyncParent(path)
}

func EnsureAvailable(dataDir string) (string, error) {
	path := filepath.Join(dataDir, credentialFilename)
	if _, err := os.Stat(path); err == nil {
		return "", fmt.Errorf("credential already exists at %s", path)
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect credential path: %w", err)
	}
	return path, nil
}

func Load(dataDir string) (Credential, error) {
	source, err := os.ReadFile(filepath.Join(dataDir, credentialFilename))
	if err != nil {
		return Credential{}, fmt.Errorf("read credential: %w", err)
	}
	var credential Credential
	if err := json.Unmarshal(source, &credential); err != nil {
		return Credential{}, fmt.Errorf("decode credential: %w", err)
	}
	if credential.DeviceID == "" || credential.Token == "" {
		return Credential{}, fmt.Errorf("credential is incomplete")
	}
	if err := validateCredentialTrust(credential); err != nil {
		return Credential{}, err
	}
	return credential, nil
}

// ValidateCredentialOrigin prevents a Device credential from crossing the
// exact origin at which it was issued. Trusting a public CA or a legacy leaf
// pin authenticates a TLS endpoint; it does not prove that a different origin
// belongs to the same Central installation.
func ValidateCredentialOrigin(serverURL string, credential Credential) error {
	if strings.TrimSpace(credential.ServerURL) == "" ||
		!sameServerOrigin(serverURL, credential.ServerURL) {
		return fmt.Errorf("Device credential is bound to a different Central origin; use explicit safe migration or re-pair the Device")
	}
	return nil
}

func validateCredentialTrust(credential Credential) error {
	if credential.ScopedPrivateTrust == nil {
		return nil
	}
	origin, err := exactHTTPSOrigin(credential.ServerURL)
	if err != nil {
		return fmt.Errorf("scoped private trust requires an exact HTTPS credential Server URL")
	}
	if _, err := credential.ScopedPrivateTrust.validate(origin, time.Now()); err != nil {
		return fmt.Errorf("credential scoped private trust is invalid: %w", err)
	}
	return nil
}

func HTTPClient(cfg config.Config) *http.Client {
	parsed, _ := url.Parse(cfg.ServerURL)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if parsed != nil && parsed.Scheme == "https" && cfg.ResolvedTrustMode() == config.TrustPinnedSHA256 {
		expected, _ := hex.DecodeString(strings.ReplaceAll(cfg.ServerCertificateSHA256, ":", ""))
		transport.TLSClientConfig = &tls.Config{
			MinVersion:         tls.VersionTLS13,
			InsecureSkipVerify: true,
			VerifyConnection: func(state tls.ConnectionState) error {
				if len(state.PeerCertificates) == 0 {
					return fmt.Errorf("server presented no certificate")
				}
				actual := sha256.Sum256(state.PeerCertificates[0].Raw)
				if subtle.ConstantTimeCompare(actual[:], expected) != 1 {
					return fmt.Errorf("server certificate fingerprint mismatch")
				}
				return nil
			},
		}
	}
	return &http.Client{Transport: transport}
}

func HTTPClientForCredential(cfg config.Config, credential Credential) *http.Client {
	if credential.ScopedPrivateTrust == nil {
		return HTTPClient(cfg)
	}
	client, err := newScopedHTTPClient(cfg.ServerURL, *credential.ScopedPrivateTrust, time.Now())
	if err != nil {
		return &http.Client{Transport: errorTransport{err: err}}
	}
	return client
}
