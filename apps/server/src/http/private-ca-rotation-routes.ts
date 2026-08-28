import type {
  DevicePairingPrivateCARotationAcknowledgeRequest
} from "@agent-room/contracts/pairing-session";

import {
  bearerToken,
  bodyObject,
  noStore,
  requiredPositiveInteger,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

export function registerPrivateCARotationRoutes({
  app,
  auth,
  clock,
  privateCARotation
}: ServerRouteContext): void {
  app.get("/api/bridge/private-ca-rotation", async (request, reply) => {
    const principal = auth.authenticateDevice(bearerToken(request), clock());
    noStore(reply);
    const offer = privateCARotation.getOffer(principal, clock());
    if (!offer) return reply.status(204).send();
    return offer;
  });

  app.post("/api/bridge/private-ca-rotation/acknowledge", async (request, reply) => {
    const principal = auth.authenticateDevice(bearerToken(request), clock());
    const body = bodyObject(request);
    const keys = Object.keys(body).sort().join(",");
    if (keys !== "acceptedNextTrustEpoch,caCertificateSha256,expectedCurrentTrustEpoch,operationId") {
      throw new Error("Private CA rotation acknowledgement contains unsupported fields");
    }
    const input: DevicePairingPrivateCARotationAcknowledgeRequest = {
      acceptedNextTrustEpoch: requiredPositiveInteger(
        body.acceptedNextTrustEpoch,
        "acceptedNextTrustEpoch"
      ),
      caCertificateSha256: requiredString(
        body.caCertificateSha256,
        "caCertificateSha256",
        64
      ),
      expectedCurrentTrustEpoch: requiredPositiveInteger(
        body.expectedCurrentTrustEpoch,
        "expectedCurrentTrustEpoch"
      ),
      operationId: requiredString(body.operationId, "operationId", 140)
    };
    privateCARotation.acknowledge(principal, input, clock());
    noStore(reply);
    return reply.status(204).send();
  });
}

