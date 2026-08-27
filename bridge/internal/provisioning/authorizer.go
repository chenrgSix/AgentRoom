package provisioning

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"sync"
	"time"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

const RotationInterval = 5 * time.Minute

type Authorizer struct {
	mu           sync.Mutex
	failures     int
	blockedUntil time.Time
}

func NewSettings(mode config.AgentProvisioningMode, fixedCode string) (config.AgentProvisioningConfig, error) {
	switch mode {
	case "", config.AgentProvisioningDisabled:
		return config.AgentProvisioningConfig{Mode: config.AgentProvisioningDisabled}, nil
	case config.AgentProvisioningFixed:
		if len(fixedCode) != 8 || !digits(fixedCode) {
			return config.AgentProvisioningConfig{}, fmt.Errorf("fixed management code must contain exactly 8 digits")
		}
		salt, err := randomBytes(16)
		if err != nil {
			return config.AgentProvisioningConfig{}, err
		}
		digest := fixedDigest(salt, fixedCode)
		return config.AgentProvisioningConfig{
			Mode:          config.AgentProvisioningFixed,
			FixedCodeSalt: base64.RawURLEncoding.EncodeToString(salt),
			FixedCodeHash: base64.RawURLEncoding.EncodeToString(digest),
		}, nil
	case config.AgentProvisioningRotating:
		secret, err := randomBytes(32)
		if err != nil {
			return config.AgentProvisioningConfig{}, err
		}
		return config.AgentProvisioningConfig{
			Mode:           config.AgentProvisioningRotating,
			RotatingSecret: base64.RawURLEncoding.EncodeToString(secret),
		}, nil
	default:
		return config.AgentProvisioningConfig{}, fmt.Errorf("management code mode must be disabled, fixed, or rotating")
	}
}

func CurrentCode(settings config.AgentProvisioningConfig, now time.Time) (string, time.Time, error) {
	if settings.Mode != config.AgentProvisioningRotating {
		return "", time.Time{}, fmt.Errorf("rotating management code is not enabled")
	}
	secret, err := base64.RawURLEncoding.DecodeString(settings.RotatingSecret)
	if err != nil || len(secret) != 32 {
		return "", time.Time{}, fmt.Errorf("rotating management code secret is invalid")
	}
	window := now.UTC().Unix() / int64(RotationInterval/time.Second)
	var source [8]byte
	binary.BigEndian.PutUint64(source[:], uint64(window))
	digest := hmac.New(sha256.New, secret)
	_, _ = digest.Write(source[:])
	value := binary.BigEndian.Uint32(digest.Sum(nil)[:4]) % 1_000_000
	rotatesAt := time.Unix((window+1)*int64(RotationInterval/time.Second), 0).UTC()
	return fmt.Sprintf("%06d", value), rotatesAt, nil
}

func (a *Authorizer) Verify(
	settings config.AgentProvisioningConfig,
	code string,
	now time.Time,
) (bool, contracts.Reason) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if settings.Mode == "" || settings.Mode == config.AgentProvisioningDisabled {
		return false, contracts.ProvisioningDisabled
	}
	if now.Before(a.blockedUntil) {
		return false, contracts.RateLimited
	}
	valid := false
	switch settings.Mode {
	case config.AgentProvisioningFixed:
		salt, saltErr := base64.RawURLEncoding.DecodeString(settings.FixedCodeSalt)
		expected, hashErr := base64.RawURLEncoding.DecodeString(settings.FixedCodeHash)
		if saltErr == nil && hashErr == nil && len(code) == 8 && digits(code) {
			actual := fixedDigest(salt, code)
			valid = len(expected) == len(actual) && subtle.ConstantTimeCompare(expected, actual) == 1
		}
	case config.AgentProvisioningRotating:
		expected, _, err := CurrentCode(settings, now)
		if err == nil && len(code) == 6 && digits(code) {
			valid = subtle.ConstantTimeCompare([]byte(expected), []byte(code)) == 1
		}
	default:
		return false, contracts.ProvisioningDisabled
	}
	if valid {
		a.failures = 0
		a.blockedUntil = time.Time{}
		return true, ""
	}
	a.failures++
	if a.failures >= 5 {
		exponent := a.failures - 5
		if exponent > 5 {
			exponent = 5
		}
		delay := time.Second * time.Duration(1<<exponent)
		a.blockedUntil = now.Add(delay)
	}
	return false, contracts.InvalidCode
}

func (a *Authorizer) Reset() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.failures = 0
	a.blockedUntil = time.Time{}
}

func fixedDigest(salt []byte, code string) []byte {
	digest := sha256.New()
	_, _ = digest.Write(salt)
	_, _ = digest.Write([]byte(code))
	return digest.Sum(nil)
}

func randomBytes(length int) ([]byte, error) {
	source := make([]byte, length)
	if _, err := rand.Read(source); err != nil {
		return nil, fmt.Errorf("generate management code material: %w", err)
	}
	return source, nil
}

func digits(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}
