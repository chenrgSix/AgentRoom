import type {
  DevicePairingPrivateCARotationAcknowledgeRequest,
  DevicePairingPrivateCARotationOffer
} from "@convene-wire/contracts/pairing-session";
import type Database from "better-sqlite3";

import {
  AuthorizationError,
  type DevicePrincipal
} from "./auth-service.js";
import type { DeploymentTrustProvider } from "./deployment-trust.js";
import type { DeploymentTrustRotationProvider } from
  "./deployment-trust-rotation.js";

interface DeviceTrustRow {
  trust_epoch: number;
  trust_installation_id: string;
}

interface AcknowledgementRow {
  accepted_next_trust_epoch: number;
  ca_certificate_sha256: string;
  expected_current_trust_epoch: number;
  operation_id: string;
}

export class PrivateCARotationService {
  public constructor(
    private readonly database: Database.Database,
    private readonly deploymentTrust: DeploymentTrustProvider,
    private readonly rotationOffer: DeploymentTrustRotationProvider
  ) {}

  private requireEligibleDevice(
    principal: DevicePrincipal,
    installationId: string,
    currentTrustEpoch: number
  ): void {
    const paired = this.database.prepare(`
      SELECT trust_installation_id, trust_epoch
      FROM device_pairing_sessions
      WHERE device_id = ? AND state = 'consumed' AND trust_mode = 'private_scoped_ca'
      ORDER BY consumed_at DESC LIMIT 1
    `).get(principal.deviceId) as DeviceTrustRow | undefined;
    if (!paired || paired.trust_installation_id !== installationId ||
      paired.trust_epoch > currentTrustEpoch) {
      throw new AuthorizationError("FORBIDDEN", "Device private trust is not eligible for rotation");
    }
    if (paired.trust_epoch === currentTrustEpoch) return;
    const prior = this.database.prepare(`
      SELECT 1 FROM device_private_ca_rotation_acknowledgements
      WHERE device_id = ? AND installation_id = ? AND accepted_next_trust_epoch = ?
    `).get(principal.deviceId, installationId, currentTrustEpoch);
    if (!prior) {
      throw new AuthorizationError("FORBIDDEN", "Device private trust continuity is incomplete");
    }
  }

  public getOffer(
    principal: DevicePrincipal,
    now: string
  ): DevicePairingPrivateCARotationOffer | undefined {
    const current = this.deploymentTrust();
    const offer = this.rotationOffer();
    if (!offer) return undefined;
    if (!current || offer.currentTrustEpoch !== current.trustEpoch ||
      offer.nextTrust.installationId !== current.installationId ||
      Date.parse(now) >= Date.parse(offer.overlapEndsAt)) {
      throw new Error("Private CA rotation overlap is unavailable or expired");
    }
    this.requireEligibleDevice(
      principal,
      current.installationId,
      current.trustEpoch
    );
    return offer;
  }

  public acknowledge(
    principal: DevicePrincipal,
    input: DevicePairingPrivateCARotationAcknowledgeRequest,
    now: string
  ): void {
    const offer = this.getOffer(principal, now);
    if (!offer || input.expectedCurrentTrustEpoch !== offer.currentTrustEpoch ||
      input.acceptedNextTrustEpoch !== offer.nextTrust.trustEpoch ||
      input.caCertificateSha256 !== offer.nextTrust.caCertificateSha256 ||
      !/^op_[A-Za-z0-9_-]{8,128}$/u.test(input.operationId)) {
      throw new Error("Private CA rotation acknowledgement does not match the active offer");
    }
    const existing = this.database.prepare(`
      SELECT expected_current_trust_epoch, accepted_next_trust_epoch,
             ca_certificate_sha256, operation_id
      FROM device_private_ca_rotation_acknowledgements
      WHERE device_id = ? AND installation_id = ? AND accepted_next_trust_epoch = ?
    `).get(
      principal.deviceId,
      offer.nextTrust.installationId,
      offer.nextTrust.trustEpoch
    ) as AcknowledgementRow | undefined;
    if (existing) {
      if (existing.expected_current_trust_epoch === input.expectedCurrentTrustEpoch &&
        existing.accepted_next_trust_epoch === input.acceptedNextTrustEpoch &&
        existing.ca_certificate_sha256 === input.caCertificateSha256 &&
        existing.operation_id === input.operationId) return;
      throw new Error("Private CA rotation was already acknowledged with different proof");
    }
    this.database.prepare(`
      INSERT INTO device_private_ca_rotation_acknowledgements (
        device_id, installation_id, expected_current_trust_epoch,
        accepted_next_trust_epoch, ca_certificate_sha256, operation_id,
        acknowledged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      principal.deviceId,
      offer.nextTrust.installationId,
      input.expectedCurrentTrustEpoch,
      input.acceptedNextTrustEpoch,
      input.caCertificateSha256,
      input.operationId,
      now
    );
  }
}

