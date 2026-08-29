// Code generated from JSON Schema; DO NOT EDIT.

package pairingcontracts

import "time"

type DevicePairingSessionCreated struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt time.Time `json:"createdAt"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt        time.Time                        `json:"expiresAt"`
	OwnerMemberID    string                           `json:"ownerMemberId"`
	PairingSessionID string                           `json:"pairingSessionId"`
	ShortCode        string                           `json:"shortCode"`
	State            DevicePairingSessionCreatedState `json:"state"`
	TeamID           string                           `json:"teamId"`
	// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
	// separately and accepted only when its canonical DER digest matches.
	Trust *DevicePairingSessionCreatedTrust `json:"trust,omitempty"`
}

// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
// separately and accepted only when its canonical DER digest matches.
type DevicePairingSessionCreatedTrust struct {
	CACertificateSha256 string `json:"caCertificateSha256"`
	InstallationID      string `json:"installationId"`
	Mode                Mode   `json:"mode"`
	Origin              string `json:"origin"`
	TrustEpoch          int64  `json:"trustEpoch"`
}

// The authenticated Owner client generates claimSecret and resends the same secret with
// operationId after response loss; the Server stores only its hash and never echoes it.
type DevicePairingSessionCreateRequest struct {
	ClaimSecret string `json:"claimSecret"`
	OperationID string `json:"operationId"`
}

type DevicePairingSessionOwnerProjection struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ClaimedAt *time.Time `json:"claimedAt,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ConsumedAt *time.Time `json:"consumedAt,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt time.Time `json:"createdAt"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	DecidedAt *time.Time                                 `json:"decidedAt,omitempty"`
	Device    *DevicePairingSessionOwnerProjectionDevice `json:"device,omitempty"`
	DeviceID  *string                                    `json:"deviceId,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt        time.Time                                `json:"expiresAt"`
	OwnerMemberID    string                                   `json:"ownerMemberId"`
	PairingAttemptID *string                                  `json:"pairingAttemptId,omitempty"`
	PairingSessionID string                                   `json:"pairingSessionId"`
	State            DevicePairingSessionOwnerProjectionState `json:"state"`
	TeamID           string                                   `json:"teamId"`
	// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
	// separately and accepted only when its canonical DER digest matches.
	Trust              *DevicePairingSessionOwnerProjectionTrust `json:"trust,omitempty"`
	VerificationPhrase *string                                   `json:"verificationPhrase,omitempty"`
}

type DevicePairingSessionOwnerProjectionDevice struct {
	BridgeVersion              string   `json:"bridgeVersion"`
	DisplayName                string   `json:"displayName"`
	Platform                   Platform `json:"platform"`
	SupportsScopedPrivateTrust *bool    `json:"supportsScopedPrivateTrust,omitempty"`
}

// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
// separately and accepted only when its canonical DER digest matches.
type DevicePairingSessionOwnerProjectionTrust struct {
	CACertificateSha256 string `json:"caCertificateSha256"`
	InstallationID      string `json:"installationId"`
	Mode                Mode   `json:"mode"`
	Origin              string `json:"origin"`
	TrustEpoch          int64  `json:"trustEpoch"`
}

type DevicePairingSessionClaimRequest struct {
	ClaimSecret      *string                                `json:"claimSecret,omitempty"`
	Device           DevicePairingSessionClaimRequestDevice `json:"device"`
	OperationID      string                                 `json:"operationId"`
	PairingAttemptID string                                 `json:"pairingAttemptId"`
	PairingSessionID *string                                `json:"pairingSessionId,omitempty"`
	PollSecret       string                                 `json:"pollSecret"`
	ShortCode        *string                                `json:"shortCode,omitempty"`
	// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
	// separately and accepted only when its canonical DER digest matches.
	Trust *DevicePairingSessionClaimRequestTrust `json:"trust,omitempty"`
}

type DevicePairingSessionClaimRequestDevice struct {
	BridgeVersion              string   `json:"bridgeVersion"`
	DisplayName                string   `json:"displayName"`
	Platform                   Platform `json:"platform"`
	SupportsScopedPrivateTrust *bool    `json:"supportsScopedPrivateTrust,omitempty"`
}

// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
// separately and accepted only when its canonical DER digest matches.
type DevicePairingSessionClaimRequestTrust struct {
	CACertificateSha256 string `json:"caCertificateSha256"`
	InstallationID      string `json:"installationId"`
	Mode                Mode   `json:"mode"`
	Origin              string `json:"origin"`
	TrustEpoch          int64  `json:"trustEpoch"`
}

type DevicePairingSessionClaimed struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt          time.Time         `json:"expiresAt"`
	PairingAttemptID   string            `json:"pairingAttemptId"`
	PairingSessionID   string            `json:"pairingSessionId"`
	PollIntervalMS     int64             `json:"pollIntervalMs"`
	State              ExpectedStateEnum `json:"state"`
	VerificationPhrase string            `json:"verificationPhrase"`
}

// pairingAttemptId and pollSecret are the stable proof identity. Pending polls are not
// response-cached; terminal consumption is idempotent by this proof pair.
type DevicePairingSessionPollRequest struct {
	PairingAttemptID string `json:"pairingAttemptId"`
	PairingSessionID string `json:"pairingSessionId"`
	PollSecret       string `json:"pollSecret"`
}

type DevicePairingSessionPollProjection struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt          *time.Time                              `json:"expiresAt,omitempty"`
	PairingAttemptID   string                                  `json:"pairingAttemptId"`
	PairingSessionID   string                                  `json:"pairingSessionId"`
	RetryAfterMS       *int64                                  `json:"retryAfterMs,omitempty"`
	State              DevicePairingSessionPollProjectionState `json:"state"`
	VerificationPhrase *string                                 `json:"verificationPhrase,omitempty"`
	CredentialSource   *CredentialSource                       `json:"credentialSource,omitempty"`
	DeviceID           *string                                 `json:"deviceId,omitempty"`
	OwnerMemberID      *string                                 `json:"ownerMemberId,omitempty"`
	TeamID             *string                                 `json:"teamId,omitempty"`
}

type DevicePairingSessionApproveRequest struct {
	ExpectedState ExpectedStateEnum `json:"expectedState"`
	OperationID   string            `json:"operationId"`
}

type DevicePairingSessionRejectRequest struct {
	ExpectedState ExpectedStateEnum `json:"expectedState"`
	OperationID   string            `json:"operationId"`
	Reason        *string           `json:"reason,omitempty"`
}

type DevicePairingSessionCancelRequest struct {
	ExpectedState ExpectedState `json:"expectedState"`
	OperationID   string        `json:"operationId"`
	Reason        *string       `json:"reason,omitempty"`
}

// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
// separately and accepted only when its canonical DER digest matches.
type DevicePairingPrivateTrustDescriptor struct {
	CACertificateSha256 string `json:"caCertificateSha256"`
	InstallationID      string `json:"installationId"`
	Mode                Mode   `json:"mode"`
	Origin              string `json:"origin"`
	TrustEpoch          int64  `json:"trustEpoch"`
}

// A next-epoch public CA offered only to an authenticated Device over its current pin-valid
// channel.
type DevicePairingPrivateCARotationOffer struct {
	CACertificatePem  string `json:"caCertificatePem"`
	CurrentTrustEpoch int64  `json:"currentTrustEpoch"`
	// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
	// separately and accepted only when its canonical DER digest matches.
	NextTrust NextTrustClass `json:"nextTrust"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	OverlapEndsAt time.Time `json:"overlapEndsAt"`
}

// Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
// separately and accepted only when its canonical DER digest matches.
type NextTrustClass struct {
	CACertificateSha256 string `json:"caCertificateSha256"`
	InstallationID      string `json:"installationId"`
	Mode                Mode   `json:"mode"`
	Origin              string `json:"origin"`
	TrustEpoch          int64  `json:"trustEpoch"`
}

type DevicePairingPrivateCARotationAcknowledgeRequest struct {
	AcceptedNextTrustEpoch    int64  `json:"acceptedNextTrustEpoch"`
	CACertificateSha256       string `json:"caCertificateSha256"`
	ExpectedCurrentTrustEpoch int64  `json:"expectedCurrentTrustEpoch"`
	OperationID               string `json:"operationId"`
}

type DevicePairingSessionCreatedState string

const (
	PurpleIssued DevicePairingSessionCreatedState = "issued"
)

type Mode string

const (
	PrivateScopedCA Mode = "private_scoped_ca"
)

type Platform string

const (
	DarwinAmd64  Platform = "darwin-amd64"
	DarwinArm64  Platform = "darwin-arm64"
	LinuxAmd64   Platform = "linux-amd64"
	LinuxArm64   Platform = "linux-arm64"
	WindowsAmd64 Platform = "windows-amd64"
	WindowsArm64 Platform = "windows-arm64"
)

type DevicePairingSessionOwnerProjectionState string

const (
	Approved       DevicePairingSessionOwnerProjectionState = "approved"
	FluffyIssued   DevicePairingSessionOwnerProjectionState = "issued"
	PurpleCanceled DevicePairingSessionOwnerProjectionState = "canceled"
	PurpleClaimed  DevicePairingSessionOwnerProjectionState = "claimed"
	PurpleConsumed DevicePairingSessionOwnerProjectionState = "consumed"
	PurpleExpired  DevicePairingSessionOwnerProjectionState = "expired"
	PurpleRejected DevicePairingSessionOwnerProjectionState = "rejected"
)

type ExpectedStateEnum string

const (
	FluffyClaimed ExpectedStateEnum = "claimed"
)

type CredentialSource string

const (
	PollSecret CredentialSource = "poll_secret"
)

type DevicePairingSessionPollProjectionState string

const (
	FluffyCanceled   DevicePairingSessionPollProjectionState = "canceled"
	FluffyConsumed   DevicePairingSessionPollProjectionState = "consumed"
	FluffyExpired    DevicePairingSessionPollProjectionState = "expired"
	FluffyRejected   DevicePairingSessionPollProjectionState = "rejected"
	TentacledClaimed DevicePairingSessionPollProjectionState = "claimed"
)

type ExpectedState string

const (
	ExpectedStateClaimed ExpectedState = "claimed"
	ExpectedStateIssued  ExpectedState = "issued"
)
