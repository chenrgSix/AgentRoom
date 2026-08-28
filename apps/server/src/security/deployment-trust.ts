import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  DevicePairingPrivateTrustDescriptor
} from "@agent-room/contracts/pairing-session";

export type DeploymentTrustProvider =
  () => DevicePairingPrivateTrustDescriptor | undefined;

const installationIdPattern = /^install_[A-Za-z0-9_-]{16,128}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const descriptorKeys = new Set([
  "caCertificateSha256",
  "installationId",
  "mode",
  "origin",
  "schemaVersion",
  "trustEpoch"
]);

function exactHTTPSOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("Deployment trust origin is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Deployment trust origin is invalid");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== "" || parsed.pathname !== "/" ||
    parsed.search !== "" || parsed.hash !== "" || parsed.origin !== value
  ) {
    throw new Error("Deployment trust origin is invalid");
  }
  return value;
}

export function parseDeploymentTrustDescriptor(
  source: string,
  expectedOrigin: string
): DevicePairingPrivateTrustDescriptor {
  if (Buffer.byteLength(source, "utf8") > 16_384) {
    throw new Error("Deployment trust descriptor is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Deployment trust descriptor is malformed");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Deployment trust descriptor must be an object");
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).length !== descriptorKeys.size ||
    Object.keys(value).some((key) => !descriptorKeys.has(key)) ||
    value.schemaVersion !== 1 || value.mode !== "private_scoped_ca" ||
    !installationIdPattern.test(String(value.installationId ?? "")) ||
    !Number.isSafeInteger(value.trustEpoch) ||
    (value.trustEpoch as number) < 1 ||
    (value.trustEpoch as number) > 2_147_483_647 ||
    !digestPattern.test(String(value.caCertificateSha256 ?? ""))
  ) {
    throw new Error("Deployment trust descriptor fields are invalid");
  }
  const origin = exactHTTPSOrigin(value.origin);
  if (origin !== expectedOrigin) {
    throw new Error("Deployment trust origin does not match the Server origin");
  }
  return {
    mode: "private_scoped_ca",
    origin,
    installationId: value.installationId as string,
    trustEpoch: value.trustEpoch as number,
    caCertificateSha256: value.caCertificateSha256 as string
  };
}

export function createDeploymentTrustProvider(
  filename: string | undefined,
  expectedOrigin: string | undefined
): DeploymentTrustProvider {
  const configured = filename?.trim();
  if (!configured) return () => undefined;
  if (!expectedOrigin) {
    throw new Error(
      "Deployment trust requires trusted-team Web authentication"
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new Error("Deployment trust file must be an absolute path");
  }
  return () => {
    try {
      const metadata = lstatSync(configured);
      if (
        !metadata.isFile() || metadata.isSymbolicLink() ||
        metadata.size > 16_384
      ) {
        throw new Error("unsafe deployment trust file");
      }
      return parseDeploymentTrustDescriptor(
        readFileSync(configured, "utf8"),
        expectedOrigin
      );
    } catch {
      throw new Error("Deployment trust descriptor is unavailable or invalid");
    }
  };
}
