import { createHash, timingSafeEqual } from "node:crypto";

import { AuthorizationError } from "./auth-service.js";

export const bridgeServerTokenHeader = "x-agentroom-server-token";

export function normalizeBridgeServerToken(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim();
  const length = Buffer.byteLength(normalized, "utf8");
  if (length < 32 || length > 512 || /[\r\n]/u.test(normalized)) {
    throw new Error("AGENT_ROOM_BRIDGE_SERVER_TOKEN must contain 32 to 512 bytes");
  }
  return normalized;
}

export function assertBridgeServerToken(
  expected: string | undefined,
  supplied: string | string[] | undefined
): void {
  if (expected === undefined) return;
  const candidate = typeof supplied === "string" ? supplied : "";
  const expectedHash = createHash("sha256").update(expected).digest();
  const candidateHash = createHash("sha256").update(candidate).digest();
  if (!timingSafeEqual(candidateHash, expectedHash)) {
    throw new AuthorizationError(
      "UNAUTHENTICATED",
      "Central Server Token required"
    );
  }
}
