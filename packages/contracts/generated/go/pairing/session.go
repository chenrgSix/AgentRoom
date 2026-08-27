// Code generated from JSON Schema; DO NOT EDIT.

package pairingcontracts

import "time"

type DevicePairingSessionCreated struct {
	// RFC 3339 date-time normalized to the UTC Z suffix.
	CreatedAt time.Time `json:"createdAt"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ExpiresAt        time.Time                        `json:"expiresAt"`
	OwnerMemberID    string                           `json:"ownerMemberId"`
	PairingSessionID string                           `json:"pairingSessionId"`
	ShortCode        string                           `json:"shortCode"`
	State            DevicePairingSessionCreatedState `json:"state"`
	TeamID           string                           `json:"teamId"`
}

// The authenticated Owner client generates claimSecret and resends the same secret with
// operationId after response loss; the Server stores only its hash and never echoes it.
type DevicePairingSessionCreateRequest struct {
	ClaimSecret string `json:"claimSecret"`
	OperationID string `json:"operationId"`
}

type DevicePairingSessionOwnerProjection struct {
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ClaimedAt *time.Time `json:"claimedAt,omitempty"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ConsumedAt *time.Time `json:"consumedAt,omitempty"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	CreatedAt time.Time `json:"createdAt"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	DecidedAt *time.Time                                 `json:"decidedAt,omitempty"`
	Device    *DevicePairingSessionOwnerProjectionDevice `json:"device,omitempty"`
	DeviceID  *string                                    `json:"deviceId,omitempty"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ExpiresAt          time.Time                                `json:"expiresAt"`
	OwnerMemberID      string                                   `json:"ownerMemberId"`
	PairingAttemptID   *string                                  `json:"pairingAttemptId,omitempty"`
	PairingSessionID   string                                   `json:"pairingSessionId"`
	State              DevicePairingSessionOwnerProjectionState `json:"state"`
	TeamID             string                                   `json:"teamId"`
	VerificationPhrase *string                                  `json:"verificationPhrase,omitempty"`
}

type DevicePairingSessionOwnerProjectionDevice struct {
	BridgeVersion string   `json:"bridgeVersion"`
	DisplayName   string   `json:"displayName"`
	Platform      Platform `json:"platform"`
}

type DevicePairingSessionClaimRequest struct {
	ClaimSecret      *string                                `json:"claimSecret,omitempty"`
	Device           DevicePairingSessionClaimRequestDevice `json:"device"`
	OperationID      string                                 `json:"operationId"`
	PairingAttemptID string                                 `json:"pairingAttemptId"`
	PairingSessionID *string                                `json:"pairingSessionId,omitempty"`
	PollSecret       string                                 `json:"pollSecret"`
	ShortCode        *string                                `json:"shortCode,omitempty"`
}

type DevicePairingSessionClaimRequestDevice struct {
	BridgeVersion string   `json:"bridgeVersion"`
	DisplayName   string   `json:"displayName"`
	Platform      Platform `json:"platform"`
}

type DevicePairingSessionClaimed struct {
	// RFC 3339 date-time normalized to the UTC Z suffix.
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
	// RFC 3339 date-time normalized to the UTC Z suffix.
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

type DevicePairingSessionCreatedState string

const (
	PurpleIssued DevicePairingSessionCreatedState = "issued"
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
