import type {
  DevicePairingPrivateTrustDescriptor,
  Platform
} from "@convene-wire/contracts/pairing-session";

import {
  bodyObject,
  noStore,
  requiredBoolean,
  requiredPositiveInteger,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function privateTrustDescriptor(
  value: unknown
): DevicePairingPrivateTrustDescriptor {
  const trust = objectValue(value, "trust");
  onlyKeys(trust, [
    "mode",
    "origin",
    "installationId",
    "trustEpoch",
    "caCertificateSha256"
  ], "trust");
  if (trust.mode !== "private_scoped_ca") {
    throw new Error("trust mode is invalid");
  }
  const origin = requiredString(trust.origin, "trust.origin", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("trust.origin is invalid");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== "" || parsed.pathname !== "/" ||
    parsed.search !== "" || parsed.hash !== "" || parsed.origin !== origin
  ) {
    throw new Error("trust.origin is invalid");
  }
  const installationId = requiredString(
    trust.installationId,
    "trust.installationId",
    136
  );
  if (!/^install_[A-Za-z0-9_-]{16,128}$/u.test(installationId)) {
    throw new Error("trust.installationId is invalid");
  }
  const trustEpoch = requiredPositiveInteger(
    trust.trustEpoch,
    "trust.trustEpoch"
  );
  const caCertificateSha256 = requiredString(
    trust.caCertificateSha256,
    "trust.caCertificateSha256",
    64
  );
  if (trustEpoch > 2_147_483_647 || !/^[a-f0-9]{64}$/u.test(caCertificateSha256)) {
    throw new Error("trust descriptor is invalid");
  }
  return {
    mode: "private_scoped_ca",
    origin,
    installationId,
    trustEpoch,
    caCertificateSha256
  };
}

function claimInput(body: Record<string, unknown>) {
  const device = objectValue(body.device, "device");
  onlyKeys(device, [
    "displayName",
    "platform",
    "bridgeVersion",
    "supportsScopedPrivateTrust"
  ], "device");
  return {
    operationId: requiredString(body.operationId, "operationId", 140),
    pairingAttemptId: requiredString(
      body.pairingAttemptId,
      "pairingAttemptId",
      140
    ),
    pollSecret: requiredString(body.pollSecret, "pollSecret", 128),
    device: {
      displayName: requiredString(device.displayName, "displayName"),
      platform: requiredString(device.platform, "platform", 40) as Platform,
      bridgeVersion: requiredString(
        device.bridgeVersion,
        "bridgeVersion",
        40
      ),
      ...(device.supportsScopedPrivateTrust === undefined
        ? {}
        : {
            supportsScopedPrivateTrust: requiredBoolean(
              device.supportsScopedPrivateTrust,
              "supportsScopedPrivateTrust"
            )
          })
    },
    ...(body.trust === undefined
      ? {}
      : { trust: privateTrustDescriptor(body.trust) })
  };
}

export function registerDevicePairingSessionRoutes({
  app,
  clock,
  devicePairingSessions,
  limitAnonymous,
  principal
}: ServerRouteContext): void {
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/device-pairing-sessions",
    async (request, reply) => {
      noStore(reply);
      const body = bodyObject(request);
      onlyKeys(body, ["operationId", "claimSecret"], "request");
      const result = devicePairingSessions.create(
        principal(request),
        request.params.teamId,
        {
          operationId: requiredString(body.operationId, "operationId", 140),
          claimSecret: requiredString(body.claimSecret, "claimSecret", 128)
        },
        clock()
      );
      return result;
    }
  );

  app.get<{ Params: { teamId: string; pairingSessionId: string } }>(
    "/api/teams/:teamId/device-pairing-sessions/:pairingSessionId",
    async (request, reply) => {
      noStore(reply);
      const result = devicePairingSessions.get(
        principal(request),
        request.params.teamId,
        request.params.pairingSessionId,
        clock()
      );
      return result;
    }
  );

  app.post<{ Params: { pairingSessionId: string } }>(
    "/api/device-pairing-sessions/:pairingSessionId/claim",
    async (request, reply) => {
      noStore(reply);
      limitAnonymous(request, "device-pairing-claim");
      const body = bodyObject(request);
      onlyKeys(body, [
        "operationId",
        "pairingSessionId",
        "claimSecret",
        "pairingAttemptId",
        "pollSecret",
        "device",
        "trust"
      ], "request");
      const bodySessionId = requiredString(
        body.pairingSessionId,
        "pairingSessionId",
        140
      );
      if (bodySessionId !== request.params.pairingSessionId) {
        throw new Error("Invalid or expired Device pairing session");
      }
      const result = devicePairingSessions.claimBySecret(
        request.params.pairingSessionId,
        requiredString(body.claimSecret, "claimSecret", 128),
        claimInput(body),
        clock()
      );
      return result;
    }
  );

  app.post(
    "/api/device-pairing-session-claims",
    async (request, reply) => {
      noStore(reply);
      limitAnonymous(request, "device-pairing-manual-claim");
      const body = bodyObject(request);
      onlyKeys(body, [
        "operationId",
        "shortCode",
        "pairingAttemptId",
        "pollSecret",
        "device"
      ], "request");
      const result = devicePairingSessions.claimByShortCode(
        requiredString(body.shortCode, "shortCode", 20),
        claimInput(body),
        clock()
      );
      return result;
    }
  );

  app.post<{ Params: { pairingSessionId: string } }>(
    "/api/device-pairing-sessions/:pairingSessionId/poll",
    async (request, reply) => {
      noStore(reply);
      const body = bodyObject(request);
      onlyKeys(
        body,
        ["pairingSessionId", "pairingAttemptId", "pollSecret"],
        "request"
      );
      const bodySessionId = requiredString(
        body.pairingSessionId,
        "pairingSessionId",
        140
      );
      if (bodySessionId !== request.params.pairingSessionId) {
        throw new Error("Invalid or expired Device pairing session");
      }
      let result;
      try {
        result = devicePairingSessions.poll(
          request.params.pairingSessionId,
          requiredString(body.pairingAttemptId, "pairingAttemptId", 140),
          requiredString(body.pollSecret, "pollSecret", 128),
          clock()
        );
      } catch (error) {
        limitAnonymous(request, "device-pairing-poll-invalid");
        throw error;
      }
      if (result.state === "claimed") void reply.code(202);
      return result;
    }
  );

  for (const action of ["approve", "reject", "cancel"] as const) {
    app.post<{ Params: { teamId: string; pairingSessionId: string } }>(
      `/api/teams/:teamId/device-pairing-sessions/:pairingSessionId/${action}`,
      async (request, reply) => {
        noStore(reply);
        const body = bodyObject(request);
        onlyKeys(
          body,
          action === "approve"
            ? ["operationId", "expectedState"]
            : ["operationId", "expectedState", "reason"],
          "request"
        );
        const command = {
          operationId: requiredString(body.operationId, "operationId", 140),
          expectedState: requiredString(
            body.expectedState,
            "expectedState",
            16
          ) as "issued" | "claimed",
          ...(body.reason === undefined
            ? {}
            : { reason: requiredString(body.reason, "reason", 280) })
        };
        const actor = principal(request);
        const result = action === "approve"
          ? devicePairingSessions.approve(
              actor,
              request.params.teamId,
              request.params.pairingSessionId,
              {
                operationId: command.operationId,
                expectedState: command.expectedState as "claimed"
              },
              clock()
            )
          : action === "reject"
            ? devicePairingSessions.reject(
                actor,
                request.params.teamId,
                request.params.pairingSessionId,
                {
                  operationId: command.operationId,
                  expectedState: command.expectedState as "claimed",
                  ...(command.reason === undefined
                    ? {}
                    : { reason: command.reason })
                },
                clock()
              )
            : devicePairingSessions.cancel(
                actor,
                request.params.teamId,
                request.params.pairingSessionId,
                command,
                clock()
              );
        return result;
      }
    );
  }
}
