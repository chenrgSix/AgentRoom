package provisioning

import (
	"encoding/base64"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestFixedCodeIsReusableAndStoredOnlyAsSaltedHash(t *testing.T) {
	settings, err := NewSettings(config.AgentProvisioningFixed, "12345678")
	if err != nil {
		t.Fatal(err)
	}
	if settings.FixedCodeHash == "12345678" || settings.FixedCodeSalt == "" {
		t.Fatalf("fixed code was not converted to salted material: %#v", settings)
	}
	authorizer := &Authorizer{}
	now := time.Date(2026, 8, 27, 8, 0, 0, 0, time.UTC)
	for attempt := 0; attempt < 3; attempt++ {
		if valid, reason := authorizer.Verify(settings, "12345678", now); !valid || reason != "" {
			t.Fatalf("fixed code must remain reusable: valid=%t reason=%s", valid, reason)
		}
	}
}

func TestRotatingCodeChangesAtFiveMinuteBoundary(t *testing.T) {
	settings := config.AgentProvisioningConfig{
		Mode:           config.AgentProvisioningRotating,
		RotatingSecret: base64.RawURLEncoding.EncodeToString(make([]byte, 32)),
	}
	before := time.Date(2026, 8, 27, 8, 4, 59, 0, time.UTC)
	first, rotatesAt, err := CurrentCode(settings, before)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := CurrentCode(settings, rotatesAt)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 6 || first == second || !rotatesAt.Equal(time.Date(2026, 8, 27, 8, 5, 0, 0, time.UTC)) {
		t.Fatalf("unexpected rotation: first=%q second=%q rotatesAt=%s", first, second, rotatesAt)
	}
	authorizer := &Authorizer{}
	if valid, reason := authorizer.Verify(settings, first, before); !valid || reason != "" {
		t.Fatalf("current rotating code rejected: valid=%t reason=%s", valid, reason)
	}
	if valid, reason := authorizer.Verify(settings, first, rotatesAt); valid || reason != contracts.InvalidCode {
		t.Fatalf("expired rotating code accepted: valid=%t reason=%s", valid, reason)
	}
}

func TestFiveFailuresIntroduceBoundedIncreasingDelay(t *testing.T) {
	settings, err := NewSettings(config.AgentProvisioningFixed, "12345678")
	if err != nil {
		t.Fatal(err)
	}
	authorizer := &Authorizer{}
	now := time.Date(2026, 8, 27, 8, 0, 0, 0, time.UTC)
	for attempt := 0; attempt < 5; attempt++ {
		valid, reason := authorizer.Verify(settings, "00000000", now)
		if valid || reason != contracts.InvalidCode {
			t.Fatalf("attempt %d: valid=%t reason=%s", attempt+1, valid, reason)
		}
	}
	if valid, reason := authorizer.Verify(settings, "12345678", now); valid || reason != contracts.RateLimited {
		t.Fatalf("rate limit did not engage: valid=%t reason=%s", valid, reason)
	}
	if valid, reason := authorizer.Verify(settings, "12345678", now.Add(time.Second)); !valid || reason != "" {
		t.Fatalf("bounded delay did not expire: valid=%t reason=%s", valid, reason)
	}
}
