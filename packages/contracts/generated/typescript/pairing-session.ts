// Code generated from JSON Schema; DO NOT EDIT.

export interface DevicePairingSessionCreated {
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt:        string;
  ownerMemberId:    string;
  pairingSessionId: string;
  shortCode:        string;
  state:            DevicePairingSessionCreatedState;
  teamId:           string;
}

export type DevicePairingSessionCreatedState = "issued";

/**
 * The authenticated Owner client generates claimSecret and resends the same secret with
 * operationId after response loss; the Server stores only its hash and never echoes it.
 */
export interface DevicePairingSessionCreateRequest {
  claimSecret: string;
  operationId: string;
}

export interface DevicePairingSessionOwnerProjection {
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  claimedAt?: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  consumedAt?: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  decidedAt?: string;
  device?:    DevicePairingSessionOwnerProjectionDevice;
  deviceId?:  string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt:           string;
  ownerMemberId:       string;
  pairingAttemptId?:   string;
  pairingSessionId:    string;
  state:               DevicePairingSessionOwnerProjectionState;
  teamId:              string;
  verificationPhrase?: string;
}

export interface DevicePairingSessionOwnerProjectionDevice {
  bridgeVersion: string;
  displayName:   string;
  platform:      Platform;
}

export type Platform = "darwin-amd64" | "darwin-arm64" | "linux-amd64" | "linux-arm64" | "windows-amd64" | "windows-arm64";

export type DevicePairingSessionOwnerProjectionState = "issued" | "claimed" | "approved" | "consumed" | "rejected" | "canceled" | "expired";

export interface DevicePairingSessionClaimRequest {
  claimSecret?:      string;
  device:            DevicePairingSessionClaimRequestDevice;
  operationId:       string;
  pairingAttemptId:  string;
  pairingSessionId?: string;
  pollSecret:        string;
  shortCode?:        string;
}

export interface DevicePairingSessionClaimRequestDevice {
  bridgeVersion: string;
  displayName:   string;
  platform:      Platform;
}

export interface DevicePairingSessionClaimed {
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt:          string;
  pairingAttemptId:   string;
  pairingSessionId:   string;
  pollIntervalMs:     number;
  state:              ExpectedStateEnum;
  verificationPhrase: string;
}

export type ExpectedStateEnum = "claimed";

/**
 * pairingAttemptId and pollSecret are the stable proof identity. Pending polls are not
 * response-cached; terminal consumption is idempotent by this proof pair.
 */
export interface DevicePairingSessionPollRequest {
  pairingAttemptId: string;
  pairingSessionId: string;
  pollSecret:       string;
}

export interface DevicePairingSessionPollProjection {
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt?:          string;
  pairingAttemptId:    string;
  pairingSessionId:    string;
  retryAfterMs?:       number;
  state:               DevicePairingSessionPollProjectionState;
  verificationPhrase?: string;
  credentialSource?:   CredentialSource;
  deviceId?:           string;
  ownerMemberId?:      string;
  teamId?:             string;
}

export type CredentialSource = "poll_secret";

export type DevicePairingSessionPollProjectionState = "claimed" | "consumed" | "rejected" | "canceled" | "expired";

export interface DevicePairingSessionApproveRequest {
  expectedState: ExpectedStateEnum;
  operationId:   string;
}

export interface DevicePairingSessionRejectRequest {
  expectedState: ExpectedStateEnum;
  operationId:   string;
  reason?:       string;
}

export interface DevicePairingSessionCancelRequest {
  expectedState: ExpectedState;
  operationId:   string;
  reason?:       string;
}

export type ExpectedState = "issued" | "claimed";
