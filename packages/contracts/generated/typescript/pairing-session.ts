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
  /**
   * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
   * separately and accepted only when its canonical DER digest matches.
   */
  trust?: DevicePairingSessionCreatedTrust;
}

export type DevicePairingSessionCreatedState = "issued";

/**
 * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
 * separately and accepted only when its canonical DER digest matches.
 */
export interface DevicePairingSessionCreatedTrust {
  caCertificateSha256: string;
  installationId:      string;
  mode:                Mode;
  origin:              string;
  trustEpoch:          number;
}

export type Mode = "private_scoped_ca";

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
  expiresAt:         string;
  ownerMemberId:     string;
  pairingAttemptId?: string;
  pairingSessionId:  string;
  state:             DevicePairingSessionOwnerProjectionState;
  teamId:            string;
  /**
   * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
   * separately and accepted only when its canonical DER digest matches.
   */
  trust?:              DevicePairingSessionOwnerProjectionTrust;
  verificationPhrase?: string;
}

export interface DevicePairingSessionOwnerProjectionDevice {
  bridgeVersion:               string;
  displayName:                 string;
  platform:                    Platform;
  supportsScopedPrivateTrust?: boolean;
}

export type Platform = "darwin-amd64" | "darwin-arm64" | "linux-amd64" | "linux-arm64" | "windows-amd64" | "windows-arm64";

export type DevicePairingSessionOwnerProjectionState = "issued" | "claimed" | "approved" | "consumed" | "rejected" | "canceled" | "expired";

/**
 * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
 * separately and accepted only when its canonical DER digest matches.
 */
export interface DevicePairingSessionOwnerProjectionTrust {
  caCertificateSha256: string;
  installationId:      string;
  mode:                Mode;
  origin:              string;
  trustEpoch:          number;
}

export interface DevicePairingSessionClaimRequest {
  claimSecret?:      string;
  device:            DevicePairingSessionClaimRequestDevice;
  operationId:       string;
  pairingAttemptId:  string;
  pairingSessionId?: string;
  pollSecret:        string;
  shortCode?:        string;
  /**
   * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
   * separately and accepted only when its canonical DER digest matches.
   */
  trust?: DevicePairingSessionClaimRequestTrust;
}

export interface DevicePairingSessionClaimRequestDevice {
  bridgeVersion:               string;
  displayName:                 string;
  platform:                    Platform;
  supportsScopedPrivateTrust?: boolean;
}

/**
 * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
 * separately and accepted only when its canonical DER digest matches.
 */
export interface DevicePairingSessionClaimRequestTrust {
  caCertificateSha256: string;
  installationId:      string;
  mode:                Mode;
  origin:              string;
  trustEpoch:          number;
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

/**
 * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
 * separately and accepted only when its canonical DER digest matches.
 */
export interface DevicePairingPrivateTrustDescriptor {
  caCertificateSha256: string;
  installationId:      string;
  mode:                Mode;
  origin:              string;
  trustEpoch:          number;
}

/**
 * A next-epoch public CA offered only to an authenticated Device over its current pin-valid
 * channel.
 */
export interface DevicePairingPrivateCARotationOffer {
  caCertificatePem:  string;
  currentTrustEpoch: number;
  /**
   * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
   * separately and accepted only when its canonical DER digest matches.
   */
  nextTrust: NextTrustClass;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  overlapEndsAt: string;
}

/**
 * Public bootstrap metadata for one exact Central origin. The CA certificate is fetched
 * separately and accepted only when its canonical DER digest matches.
 */
export interface NextTrustClass {
  caCertificateSha256: string;
  installationId:      string;
  mode:                Mode;
  origin:              string;
  trustEpoch:          number;
}

export interface DevicePairingPrivateCARotationAcknowledgeRequest {
  acceptedNextTrustEpoch:    number;
  caCertificateSha256:       string;
  expectedCurrentTrustEpoch: number;
  operationId:               string;
}
