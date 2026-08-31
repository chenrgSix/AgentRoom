package pairing

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/config"
	pairingcontracts "convenewire.dev/contracts/generated/go/pairing"
)

const maxPairingResponseBytes = 1 << 20

// MaxSessionLinkBytes bounds the complete encoded link, including private trust.
const MaxSessionLinkBytes = 16 * 1024

var (
	pairingSessionIDPattern          = regexp.MustCompile(`^pairing_[A-Za-z0-9_-]{8,128}$`)
	pairingSessionOperationIDPattern = regexp.MustCompile(`^op_[A-Za-z0-9_-]{8,128}$`)
	shortCodePattern                 = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$`)
	bridgeVersionPattern             = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$`)
	verificationPattern              = regexp.MustCompile(`^[A-Z]{2,20}-[A-Z]{2,20}-[0-9]{2}$`)
	deviceIDPattern                  = regexp.MustCompile(`^device_[A-Za-z0-9_-]{8,128}$`)
	teamIDPattern                    = regexp.MustCompile(`^team_[A-Za-z0-9_-]{8,128}$`)
	memberIDPattern                  = regexp.MustCompile(`^member_[A-Za-z0-9_-]{8,128}$`)
)

type SessionInput struct {
	Link      string `json:"link,omitempty"`
	ShortCode string `json:"shortCode,omitempty"`
}

type SessionStatus struct {
	PairingSessionID   string    `json:"pairingSessionId"`
	State              string    `json:"state"`
	VerificationPhrase string    `json:"verificationPhrase"`
	ExpiresAt          time.Time `json:"expiresAt"`
}

type SessionLink struct {
	MemberAccess     bool
	ServerURL        string
	PairingSessionID string
	ClaimSecret      string
	ExpiresAt        time.Time
	Trust            *ScopedPrivateTrustDescriptor
}

type SessionClient struct {
	BridgeVersion  string
	HTTPClient     *http.Client
	BootstrapTrust func(context.Context, ScopedPrivateTrustDescriptor, time.Time) (ScopedPrivateTrust, error)
	RetryDelay     time.Duration
	Now            func() time.Time
}

func ParseSessionLink(raw string) (SessionLink, error) {
	if len(raw) > MaxSessionLinkBytes {
		return SessionLink{}, fmt.Errorf("pairing link exceeds its input limit")
	}
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil {
		return SessionLink{}, fmt.Errorf("pairing link is invalid")
	}
	query := parsed.Query()
	serverURL := ""
	switch strings.ToLower(parsed.Scheme) {
	case "convenewire", "agentroom":
		if parsed.Host != "pair-device" || parsed.Path != "" ||
			!hasExactQueryKeys(query, "origin", "pairingSessionId", "expiresAt") {
			return SessionLink{}, fmt.Errorf("pairing link target is invalid")
		}
		serverURL = query.Get("origin")
	case "https", "http":
		if parsed.Path != "/device-pairing" ||
			!hasExactQueryKeys(query, "pairingSessionId", "expiresAt") {
			return SessionLink{}, fmt.Errorf("pairing link target is invalid")
		}
		serverURL = (&url.URL{Scheme: parsed.Scheme, Host: parsed.Host}).String()
	default:
		return SessionLink{}, fmt.Errorf("pairing link scheme is unsupported")
	}
	origin, err := url.Parse(serverURL)
	if err != nil || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" ||
		(origin.Scheme != "https" && !(origin.Scheme == "http" && isLoopbackHost(origin.Hostname()))) {
		return SessionLink{}, fmt.Errorf("pairing link origin must use HTTPS except on loopback")
	}
	pairingSessionID := query.Get("pairingSessionId")
	if !pairingSessionIDPattern.MatchString(pairingSessionID) {
		return SessionLink{}, fmt.Errorf("pairing link session is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339, query.Get("expiresAt"))
	if err != nil {
		return SessionLink{}, fmt.Errorf("pairing link expiry is invalid")
	}
	fragment, err := url.ParseQuery(parsed.Fragment)
	if err != nil {
		return SessionLink{}, fmt.Errorf("pairing link claim proof is invalid")
	}
	claimSecret := fragment.Get("claimSecret")
	if !validPairingSecret(claimSecret) {
		return SessionLink{}, fmt.Errorf("pairing link claim proof is invalid")
	}
	memberAccess := false
	if values, present := fragment["memberAccess"]; present {
		if len(values) != 1 || values[0] != "1" {
			return SessionLink{}, fmt.Errorf("pairing member access marker is invalid")
		}
		memberAccess = true
		fragment.Del("memberAccess")
	}
	var trust *ScopedPrivateTrustDescriptor
	if hasExactQueryKeys(fragment, "claimSecret") {
		// Public/system trust carries no override.
	} else if hasExactQueryKeys(
		fragment,
		"claimSecret",
		"trustMode",
		"trustOrigin",
		"installationId",
		"trustEpoch",
		"caCertificateSha256",
	) {
		epoch, epochErr := canonicalTrustEpoch(fragment.Get("trustEpoch"))
		descriptor := ScopedPrivateTrustDescriptor{
			Mode:                fragment.Get("trustMode"),
			Origin:              fragment.Get("trustOrigin"),
			InstallationID:      fragment.Get("installationId"),
			TrustEpoch:          epoch,
			CACertificateSHA256: fragment.Get("caCertificateSha256"),
		}
		trustOrigin, trustErr := exactHTTPSOrigin(descriptor.Origin)
		serverOrigin, serverErr := exactHTTPSOrigin(serverURL)
		if epochErr != nil || trustErr != nil || serverErr != nil ||
			descriptor.Mode != "private_scoped_ca" ||
			!installationIDPattern.MatchString(descriptor.InstallationID) ||
			!isLowerHexDigest(descriptor.CACertificateSHA256) || trustOrigin != serverOrigin {
			return SessionLink{}, fmt.Errorf("pairing link private trust is invalid")
		}
		trust = &descriptor
	} else {
		return SessionLink{}, fmt.Errorf("pairing link claim proof is invalid")
	}
	return SessionLink{
		MemberAccess: memberAccess,
		ServerURL:    serverURL, PairingSessionID: pairingSessionID,
		ClaimSecret: claimSecret, ExpiresAt: expiresAt, Trust: trust,
	}, nil
}

func (client SessionClient) Pair(
	ctx context.Context,
	cfg config.Config,
	input SessionInput,
	show func(SessionStatus),
) (Credential, error) {
	if err := cfg.Validate(); err != nil {
		return Credential{}, err
	}
	linkValue := strings.TrimSpace(input.Link)
	shortCode := strings.ToUpper(strings.TrimSpace(input.ShortCode))
	if (linkValue == "") == (shortCode == "") {
		return Credential{}, fmt.Errorf("provide exactly one pairing link or short code")
	}
	var link SessionLink
	var err error
	if linkValue != "" {
		link, err = ParseSessionLink(linkValue)
		if err != nil {
			return Credential{}, err
		}
		if !sameServerOrigin(cfg.ServerURL, link.ServerURL) {
			return Credential{}, fmt.Errorf("pairing link origin does not match the configured Server")
		}
	} else if !shortCodePattern.MatchString(shortCode) {
		return Credential{}, fmt.Errorf("pairing short code is invalid")
	}
	now := client.Now
	if now == nil {
		now = time.Now
	}
	if !link.ExpiresAt.IsZero() && !now().Before(link.ExpiresAt) {
		return Credential{}, fmt.Errorf("pairing link has expired")
	}
	activeClient := client
	var stagedTrust *ScopedPrivateTrust
	if link.Trust != nil {
		bootstrap := client.BootstrapTrust
		if bootstrap == nil {
			bootstrap = BootstrapScopedPrivateTrust
		}
		staged, bootstrapErr := bootstrap(ctx, *link.Trust, now())
		if bootstrapErr != nil {
			return Credential{}, fmt.Errorf("bootstrap scoped private trust: %w", bootstrapErr)
		}
		verifiedClient, clientErr := newScopedHTTPClient(link.ServerURL, staged, now())
		if clientErr != nil {
			return Credential{}, fmt.Errorf("activate scoped private trust: %w", clientErr)
		}
		verifiedClient.Timeout = 30 * time.Second
		activeClient.HTTPClient = verifiedClient
		stagedTrust = &staged
	}
	pollSecret, err := randomPairingValue(32)
	if err != nil {
		return Credential{}, err
	}
	attemptID, err := randomPairingID("pairattempt")
	if err != nil {
		return Credential{}, err
	}
	operationID, err := randomPairingID("op")
	if err != nil {
		return Credential{}, err
	}
	platform := pairingcontracts.Platform(runtime.GOOS + "-" + runtime.GOARCH)
	if !supportedPairingPlatform(platform) {
		return Credential{}, fmt.Errorf("Device pairing is unsupported on %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	version := NormalizedBridgeVersion(client.BridgeVersion)
	claim := pairingcontracts.DevicePairingSessionClaimRequest{
		OperationID: operationID, PairingAttemptID: attemptID, PollSecret: pollSecret,
		Device: pairingcontracts.DevicePairingSessionClaimRequestDevice{
			DisplayName: cfg.DeviceName, Platform: platform, BridgeVersion: version,
		},
	}
	clientAccessSecret := ""
	if link.MemberAccess {
		clientAccessSecret, err = randomPairingValue(32)
		if err != nil {
			return Credential{}, err
		}
		claim.ClientAccessSecret = &clientAccessSecret
	}
	supportsScopedPrivateTrust := true
	claim.Device.SupportsScopedPrivateTrust = &supportsScopedPrivateTrust
	endpoint := strings.TrimRight(cfg.ServerURL, "/") + "/api/device-pairing-session-claims"
	if linkValue != "" {
		claim.PairingSessionID = &link.PairingSessionID
		claim.ClaimSecret = &link.ClaimSecret
		if link.Trust != nil {
			claim.Trust = &pairingcontracts.DevicePairingSessionClaimRequestTrust{
				Mode:   pairingcontracts.Mode(link.Trust.Mode),
				Origin: link.Trust.Origin, InstallationID: link.Trust.InstallationID,
				TrustEpoch:          link.Trust.TrustEpoch,
				CACertificateSha256: link.Trust.CACertificateSHA256,
			}
		}
		endpoint = strings.TrimRight(cfg.ServerURL, "/") + "/api/device-pairing-sessions/" +
			url.PathEscape(link.PairingSessionID) + "/claim"
	} else {
		claim.ShortCode = &shortCode
	}
	var claimed pairingcontracts.DevicePairingSessionClaimed
	claimDeadline := link.ExpiresAt
	if claimDeadline.IsZero() {
		claimDeadline = now().Add(10 * time.Minute)
	}
	if err := activeClient.postRecoverable(ctx, cfg, endpoint, claim, &claimed, claimDeadline); err != nil {
		return Credential{}, fmt.Errorf("claim Device pairing session: %w", err)
	}
	if !pairingSessionIDPattern.MatchString(claimed.PairingSessionID) ||
		claimed.PairingAttemptID != attemptID || claimed.State != pairingcontracts.FluffyClaimed ||
		!verificationPattern.MatchString(claimed.VerificationPhrase) ||
		claimed.PollIntervalMS < 500 || claimed.PollIntervalMS > 10_000 ||
		claimed.ExpiresAt.IsZero() || !now().Before(claimed.ExpiresAt) {
		return Credential{}, fmt.Errorf("Device pairing claim response is invalid")
	}
	if linkValue != "" && (claimed.PairingSessionID != link.PairingSessionID ||
		!claimed.ExpiresAt.Equal(link.ExpiresAt)) {
		return Credential{}, fmt.Errorf("Device pairing claim response changed the session")
	}
	status := SessionStatus{
		PairingSessionID: claimed.PairingSessionID, State: "claimed",
		VerificationPhrase: claimed.VerificationPhrase, ExpiresAt: claimed.ExpiresAt,
	}
	if show != nil {
		show(status)
	}
	for {
		if !now().Before(claimed.ExpiresAt) {
			return Credential{}, fmt.Errorf("Device pairing session expired before approval")
		}
		poll := pairingcontracts.DevicePairingSessionPollRequest{
			PairingSessionID: claimed.PairingSessionID,
			PairingAttemptID: attemptID,
			PollSecret:       pollSecret,
		}
		var projection pairingcontracts.DevicePairingSessionPollProjection
		pollEndpoint := strings.TrimRight(cfg.ServerURL, "/") + "/api/device-pairing-sessions/" +
			url.PathEscape(claimed.PairingSessionID) + "/poll"
		if err := activeClient.postRecoverable(ctx, cfg, pollEndpoint, poll, &projection, claimed.ExpiresAt); err != nil {
			return Credential{}, fmt.Errorf("poll Device pairing session: %w", err)
		}
		if projection.PairingSessionID != claimed.PairingSessionID || projection.PairingAttemptID != attemptID {
			return Credential{}, fmt.Errorf("Device pairing poll response changed proof identity")
		}
		switch projection.State {
		case pairingcontracts.FluffyConsumed:
			if link.MemberAccess != (projection.ClientAccessEnabled != nil && *projection.ClientAccessEnabled) {
				return Credential{}, fmt.Errorf("pairing did not confirm the requested member access")
			}
			if projection.CredentialSource == nil || *projection.CredentialSource != pairingcontracts.PollSecret ||
				projection.DeviceID == nil || !deviceIDPattern.MatchString(*projection.DeviceID) ||
				projection.TeamID == nil || !teamIDPattern.MatchString(*projection.TeamID) ||
				projection.OwnerMemberID == nil || !memberIDPattern.MatchString(*projection.OwnerMemberID) ||
				projection.VerificationPhrase != nil || projection.ExpiresAt != nil || projection.RetryAfterMS != nil {
				return Credential{}, fmt.Errorf("Device pairing consumption omitted identity")
			}
			return Credential{
				ClientAccessSecret: clientAccessSecret,
				ServerURL:          cfg.ServerURL, DeviceID: *projection.DeviceID, TeamID: *projection.TeamID,
				OwnerMemberID: *projection.OwnerMemberID, Token: pollSecret,
				ScopedPrivateTrust: stagedTrust,
			}, nil
		case pairingcontracts.TentacledClaimed:
			if projection.VerificationPhrase == nil || *projection.VerificationPhrase != claimed.VerificationPhrase ||
				projection.ExpiresAt == nil || !projection.ExpiresAt.Equal(claimed.ExpiresAt) ||
				projection.RetryAfterMS == nil || *projection.RetryAfterMS < 500 || *projection.RetryAfterMS > 10_000 ||
				projection.CredentialSource != nil || projection.DeviceID != nil ||
				projection.TeamID != nil || projection.OwnerMemberID != nil {
				return Credential{}, fmt.Errorf("Device pairing pending response is invalid")
			}
			wait := time.Duration(*projection.RetryAfterMS) * time.Millisecond
			if err := waitForPairing(ctx, wait); err != nil {
				return Credential{}, err
			}
		case pairingcontracts.FluffyRejected, pairingcontracts.FluffyCanceled, pairingcontracts.FluffyExpired:
			if projection.ExpiresAt == nil || projection.VerificationPhrase != nil ||
				projection.RetryAfterMS != nil || projection.CredentialSource != nil ||
				projection.DeviceID != nil || projection.TeamID != nil || projection.OwnerMemberID != nil {
				return Credential{}, fmt.Errorf("Device pairing terminal response is invalid")
			}
			return Credential{}, fmt.Errorf("Device pairing session is %s", projection.State)
		default:
			return Credential{}, fmt.Errorf("Device pairing poll returned an unknown state")
		}
	}
}

func (client SessionClient) postRecoverable(
	ctx context.Context,
	cfg config.Config,
	endpoint string,
	requestBody any,
	responseBody any,
	expiresAt time.Time,
) error {
	delay := client.RetryDelay
	if delay <= 0 {
		delay = 500 * time.Millisecond
	}
	now := client.Now
	if now == nil {
		now = time.Now
	}
	for {
		status, source, err := client.postJSON(ctx, cfg, endpoint, requestBody)
		if err == nil && status >= 200 && status < 300 {
			if decodeErr := decodePairingResponse(source, responseBody); decodeErr == nil {
				return nil
			} else {
				err = fmt.Errorf("decode response: %w", decodeErr)
			}
		}
		if err == nil && status < 500 && status != http.StatusRequestTimeout && status != http.StatusTooManyRequests {
			return fmt.Errorf("request rejected with status %d", status)
		}
		if !expiresAt.IsZero() && !now().Add(delay).Before(expiresAt) {
			return fmt.Errorf("request could not recover before expiry")
		}
		if waitErr := waitForPairing(ctx, delay); waitErr != nil {
			return waitErr
		}
	}
}

func decodePairingResponse(source []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("response contains a second JSON value")
		}
		return err
	}
	return nil
}

func (client SessionClient) postJSON(
	ctx context.Context,
	cfg config.Config,
	endpoint string,
	requestBody any,
) (int, []byte, error) {
	body, err := json.Marshal(requestBody)
	if err != nil {
		return 0, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("content-type", "application/json")
	httpClient := client.HTTPClient
	if httpClient == nil {
		httpClient = HTTPClient(cfg)
		httpClient.Timeout = 30 * time.Second
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	source, err := io.ReadAll(io.LimitReader(response.Body, maxPairingResponseBytes+1))
	if err != nil {
		return response.StatusCode, nil, err
	}
	if len(source) > maxPairingResponseBytes {
		return response.StatusCode, nil, fmt.Errorf("response exceeds the pairing limit")
	}
	return response.StatusCode, source, nil
}

func NormalizedBridgeVersion(value string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(value), "v")
	if bridgeVersionPattern.MatchString(trimmed) {
		return trimmed
	}
	return "0.0.0-dev"
}

func randomPairingID(prefix string) (string, error) {
	value, err := randomPairingValue(16)
	if err != nil {
		return "", err
	}
	return prefix + "_" + value, nil
}

func randomPairingValue(size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate Device pairing proof: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func validPairingSecret(value string) bool {
	if len(value) < 43 || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(character >= 'A' && character <= 'Z') &&
			!(character >= 'a' && character <= 'z') &&
			!(character >= '0' && character <= '9') && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

func hasExactQueryKeys(query url.Values, keys ...string) bool {
	if len(query) != len(keys) {
		return false
	}
	for _, key := range keys {
		values, ok := query[key]
		if !ok || len(values) != 1 || values[0] == "" {
			return false
		}
	}
	return true
}

func sameServerOrigin(left string, right string) bool {
	leftURL, leftErr := url.Parse(left)
	rightURL, rightErr := url.Parse(right)
	if leftErr != nil || rightErr != nil {
		return false
	}
	return strings.EqualFold(leftURL.Scheme, rightURL.Scheme) &&
		strings.EqualFold(leftURL.Host, rightURL.Host)
}

func supportedPairingPlatform(platform pairingcontracts.Platform) bool {
	switch platform {
	case pairingcontracts.DarwinAmd64, pairingcontracts.DarwinArm64,
		pairingcontracts.LinuxAmd64, pairingcontracts.LinuxArm64,
		pairingcontracts.WindowsAmd64, pairingcontracts.WindowsArm64:
		return true
	default:
		return false
	}
}

func waitForPairing(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
