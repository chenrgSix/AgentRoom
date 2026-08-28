import { createHash, X509Certificate } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  DevicePairingPrivateCARotationOffer,
  DevicePairingPrivateTrustDescriptor
} from "@convene-wire/contracts/pairing-session";

import type { DeploymentTrustProvider } from "./deployment-trust.js";

export type DeploymentTrustRotationProvider =
  () => DevicePairingPrivateCARotationOffer | undefined;

const offerKeys = new Set([
  "caCertificatePem",
  "currentTrustEpoch",
  "nextTrust",
  "overlapEndsAt",
  "schemaVersion"
]);
const trustKeys = new Set([
  "caCertificateSha256",
  "installationId",
  "mode",
  "origin",
  "trustEpoch"
]);

function exactKeys(
  value: Record<string, unknown>,
  expected: Set<string>
): boolean {
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function nextTrustDescriptor(
  value: unknown,
  current: DevicePairingPrivateTrustDescriptor
): DevicePairingPrivateTrustDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Private CA rotation next trust is invalid");
  }
  const next = value as Record<string, unknown>;
  if (
    !exactKeys(next, trustKeys) || next.mode !== "private_scoped_ca" ||
    next.origin !== current.origin ||
    next.installationId !== current.installationId ||
    next.trustEpoch !== current.trustEpoch + 1 ||
    typeof next.caCertificateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(next.caCertificateSha256) ||
    next.caCertificateSha256 === current.caCertificateSha256
  ) {
    throw new Error("Private CA rotation next trust is invalid");
  }
  return {
    caCertificateSha256: next.caCertificateSha256,
    installationId: current.installationId,
    mode: "private_scoped_ca",
    origin: current.origin,
    trustEpoch: current.trustEpoch + 1
  };
}

function canonicalCA(
  value: unknown,
  expectedDigest: string
): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 8_192) {
    throw new Error("Private CA rotation certificate is invalid");
  }
  const matches = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
  if (matches?.length !== 1 || value.trim() !== matches[0]) {
    throw new Error("Private CA rotation must contain exactly one certificate");
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(value);
  } catch {
    throw new Error("Private CA rotation certificate is invalid");
  }
  if (!certificate.ca || Date.now() < Date.parse(certificate.validFrom) ||
    Date.now() >= Date.parse(certificate.validTo)) {
    throw new Error("Private CA rotation certificate is not a valid CA");
  }
  const digest = createHash("sha256").update(certificate.raw).digest("hex");
  if (digest !== expectedDigest) {
    throw new Error("Private CA rotation certificate digest does not match");
  }
  return `${matches[0]}\n`;
}

export function parseDeploymentTrustRotationOffer(
  source: string,
  current: DevicePairingPrivateTrustDescriptor
): DevicePairingPrivateCARotationOffer {
  if (Buffer.byteLength(source, "utf8") > 16_384) {
    throw new Error("Private CA rotation offer is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Private CA rotation offer is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Private CA rotation offer must be an object");
  }
  const value = parsed as Record<string, unknown>;
  if (!exactKeys(value, offerKeys) || value.schemaVersion !== 1 ||
    value.currentTrustEpoch !== current.trustEpoch ||
    typeof value.overlapEndsAt !== "string" ||
    !Number.isFinite(Date.parse(value.overlapEndsAt))) {
    throw new Error("Private CA rotation offer fields are invalid");
  }
  const nextTrust = nextTrustDescriptor(value.nextTrust, current);
  return {
    caCertificatePem: canonicalCA(
      value.caCertificatePem,
      nextTrust.caCertificateSha256
    ),
    currentTrustEpoch: current.trustEpoch,
    nextTrust,
    overlapEndsAt: value.overlapEndsAt
  };
}

export function createDeploymentTrustRotationProvider(
  filename: string | undefined,
  deploymentTrust: DeploymentTrustProvider
): DeploymentTrustRotationProvider {
  const configured = filename?.trim();
  if (!configured) return () => undefined;
  if (!path.isAbsolute(configured)) {
    throw new Error("Deployment trust rotation file must be absolute");
  }
  return () => {
    if (!existsSync(configured)) return undefined;
    try {
      const current = deploymentTrust();
      if (!current) throw new Error("private deployment trust is unavailable");
      const metadata = lstatSync(configured);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) {
        throw new Error("unsafe deployment trust rotation file");
      }
      return parseDeploymentTrustRotationOffer(
        readFileSync(configured, "utf8"),
        current
      );
    } catch {
      throw new Error("Deployment trust rotation offer is unavailable or invalid");
    }
  };
}
