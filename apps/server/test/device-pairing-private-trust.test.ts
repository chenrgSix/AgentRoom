import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  DevicePairingPrivateTrustDescriptor
} from "@agent-room/contracts/pairing-session";

import { createServerApp } from "../src/app.js";
import {
  createDeploymentTrustProvider,
  parseDeploymentTrustDescriptor
} from "../src/security/deployment-trust.js";
import {
  parseDeploymentTrustRotationOffer
} from "../src/security/deployment-trust-rotation.js";

const now = "2026-08-28T10:00:00.000Z";
const publicOrigin = "https://192.0.2.25:9443";
const recoveryToken = "owner-recovery-token-0123456789abcdef";
const claimSecret = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const pollSecret = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
const trust: DevicePairingPrivateTrustDescriptor = {
  mode: "private_scoped_ca",
  origin: publicOrigin,
  installationId: "install_0123456789abcdefghijklmn",
  trustEpoch: 1,
  caCertificateSha256: "a".repeat(64)
};
const rotationCAPEM = `-----BEGIN CERTIFICATE-----
MIIDOzCCAiOgAwIBAgIUQhGHwZZGvIZbpdqz22mrLGpXcuYwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaQWdlbnRSb29tIFJvdGF0aW9uIFRlc3QgQ0EwHhcNMjYw
ODI4MDIwMDA2WhcNMzYwODI1MDIwMDA2WjAlMSMwIQYDVQQDDBpBZ2VudFJvb20g
Um90YXRpb24gVGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
APckMT4ax7E+YFRp4d7Nh2QFzjZXEe9Sy5/1/x7+PzdBL7M6DblOsv6GqOZpXiAn
kuB3UobNhSaATixu/SyG5G3p2+5Zc559ahzGZkycMYdnh5qjK29p+Ec9cewMlzyg
FMc1emRI4/wD92sUumaRJgOyBneHLpPFPdZT/HBranqKpPt3Aq7KFgtEhsOTRtlz
CY9Qz7TZeC8uAVCJST3VcqUqRmF/idQ3mq2Uvy+2B82g15+tSUZ7zNdUA0LtXxqU
eNBzXqTU/4hP36WcjbAjvHN2bzGnpxQq4xdpTTnXKH9eQszxN8nvQuuq01L60zaI
Gl8bwhUxzIkY2q3ETmdRST0CAwEAAaNjMGEwHQYDVR0OBBYEFNiXGp8K3hMNPkDa
KmO3OIgXRlFhMB8GA1UdIwQYMBaAFNiXGp8K3hMNPkDaKmO3OIgXRlFhMA8GA1Ud
EwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMA0GCSqGSIb3DQEBCwUAA4IBAQDM
8+PzTzNfhjgemRFWdbtT/qidPm1cyraAXBq/e5106F8MGidCjjSTT/K0ThWrxfp6
XKAVmosmaLGxIdtwRTOZYDF2NdsqS2Mv8X54O7CzxmdKQTT7lZBpsMt+4u4Q04R5
cIRcML8fO4ac75IrM889C3+InYD2JnkFQyLatGn4RkW4O6hMSR8cBfO12K34RKR8
tTQ91oJXtE5yV3y02E9KzfXlF8iIuKfbT/6KQKImgb4YwVi930Rt6EqId7nF7411
rKeugMdyo+IAhCKMKM8dliPTqua/Zu7K/rdyjqQgzVOGTEnmmP2hw1UF/VfDcKUG
ze/eqbrbWaniaAqFZ7BK
-----END CERTIFICATE-----
`;
const rotationDigest = "18a48a31ecaf6bd5ee01f7837777db8fc482694054664cabdf848643fda1c2ca";

function rotationOfferValue(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    currentTrustEpoch: 1,
    nextTrust: {
      ...trust,
      trustEpoch: 2,
      caCertificateSha256: rotationDigest
    },
    caCertificatePem: rotationCAPEM,
    overlapEndsAt: "2026-08-29T10:00:00.000Z"
  }, null, 2)}\n`;
}

function trustFileValue(
  descriptor: DevicePairingPrivateTrustDescriptor = trust
): string {
  return `${JSON.stringify({ schemaVersion: 1, ...descriptor }, null, 2)}\n`;
}

function responseCookie(response: { headers: Record<string, unknown> }): string {
  const header = String(response.headers["set-cookie"] ?? "");
  const match = /^(__Host-agentroom_session=[^;]+)/u.exec(header);
  assert.ok(match, `missing trusted session cookie: ${header}`);
  return match[1];
}

test("private pairing snapshots controller trust and requires an exact capable echo", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-private-trust-"));
  const trustPath = path.join(directory, "deployment-trust.json");
  await writeFile(trustPath, trustFileValue(), { mode: 0o644 });
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    deploymentTrustFile: trustPath,
    clock: () => now,
    webAuth: {
      mode: "trusted-team",
      ownerRecoveryToken: recoveryToken,
      publicOrigin
    }
  });
  try {
    const unauthenticatedOffer = await app.inject({
      method: "GET",
      url: "/api/bridge/private-ca-rotation"
    });
    assert.equal(unauthenticatedOffer.statusCode, 401);

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Alice" }
    });
    assert.equal(setup.statusCode, 200);
    const ownerHeaders = {
      cookie: responseCookie(setup),
      origin: publicOrigin
    };
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: ownerHeaders,
      payload: { name: "Private Team" }
    });
    assert.equal(team.statusCode, 200);
    const teamId = team.json().team.teamId as string;

    const createSession = async (operationId: string) => app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: ownerHeaders,
      payload: { operationId, claimSecret }
    });
    const created = await createSession("op_createprivate00000000000000000001");
    assert.equal(created.statusCode, 200);
    assert.deepEqual(created.json().trust, trust);
    const pairingSessionId = created.json().pairingSessionId as string;

    const baseClaim = {
      operationId: "op_claimprivate000000000000000000001",
      pairingSessionId,
      claimSecret,
      pairingAttemptId: "pairattempt_private000000000000000001",
      pollSecret,
      device: {
        displayName: "Bob Windows",
        platform: "windows-amd64",
        bridgeVersion: "0.4.0-qa028.1",
        supportsScopedPrivateTrust: true
      },
      trust
    };
    const missingTrust = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: { ...baseClaim, trust: undefined }
    });
    assert.equal(missingTrust.statusCode, 400);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: {
        ...baseClaim,
        trust: { ...trust, origin: "https://other.example.com" }
      }
    });
    assert.equal(wrongOrigin.statusCode, 400);

    const legacyBridge = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: {
        ...baseClaim,
        device: {
          displayName: "Bob Windows",
          platform: "windows-amd64",
          bridgeVersion: "0.3.0-rc.6"
        }
      }
    });
    assert.equal(legacyBridge.statusCode, 400);

    const shortCodeClaim = await app.inject({
      method: "POST",
      url: "/api/device-pairing-session-claims",
      payload: {
        operationId: baseClaim.operationId,
        shortCode: created.json().shortCode,
        pairingAttemptId: baseClaim.pairingAttemptId,
        pollSecret,
        device: baseClaim.device
      }
    });
    assert.equal(shortCodeClaim.statusCode, 400);

    const claimed = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: baseClaim
    });
    assert.equal(claimed.statusCode, 200);
    assert.match(
      claimed.json().verificationPhrase,
      /^[A-Z]+-[A-Z]+-[0-9]{2}$/u
    );

    const ownerProjection = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}`,
      headers: { cookie: ownerHeaders.cookie }
    });
    assert.equal(ownerProjection.statusCode, 200);
    assert.deepEqual(ownerProjection.json().trust, trust);
    assert.equal(
      ownerProjection.json().device.supportsScopedPrivateTrust,
      true
    );
    assert.equal(JSON.stringify(ownerProjection.json()).includes(claimSecret), false);
  } finally {
    await app.close();
  }
});

test("deployment trust parsing rejects tampering, extra fields, and origin mismatch", async () => {
  assert.deepEqual(parseDeploymentTrustDescriptor(
    trustFileValue(),
    publicOrigin
  ), trust);
  assert.throws(
    () => parseDeploymentTrustDescriptor(
      JSON.stringify({ schemaVersion: 1, ...trust, privateKey: "forbidden" }),
      publicOrigin
    ),
    /fields are invalid/u
  );
  assert.throws(
    () => parseDeploymentTrustDescriptor(trustFileValue(), "https://other.example.com"),
    /does not match/u
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-trust-file-"));
  const trustPath = path.join(directory, "deployment-trust.json");
  await writeFile(trustPath, trustFileValue(), { mode: 0o644 });
  const provider = createDeploymentTrustProvider(trustPath, publicOrigin);
  assert.deepEqual(provider(), trust);
  await writeFile(trustPath, `${"x".repeat(16_385)}\n`, { mode: 0o644 });
  assert.throws(() => provider(), /unavailable or invalid/u);
});

test("authenticated private Device receives and idempotently acknowledges one next CA", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-private-rotation-"));
  const trustPath = path.join(directory, "deployment-trust.json");
  const rotationPath = path.join(directory, "deployment-trust-rotation.json");
  await writeFile(trustPath, trustFileValue(), { mode: 0o644 });
  await writeFile(rotationPath, rotationOfferValue(), { mode: 0o644 });
  assert.equal(
    parseDeploymentTrustRotationOffer(rotationOfferValue(), trust).nextTrust.trustEpoch,
    2
  );
  assert.throws(() => parseDeploymentTrustRotationOffer(
    rotationOfferValue().replace(rotationDigest, "b".repeat(64)),
    trust
  ), /digest does not match/u);
  const multipleCertificates = JSON.parse(rotationOfferValue()) as {
    caCertificatePem: string;
  };
  multipleCertificates.caCertificatePem += rotationCAPEM;
  assert.throws(() => parseDeploymentTrustRotationOffer(
    JSON.stringify(multipleCertificates),
    trust
  ), /exactly one certificate/u);
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    deploymentTrustFile: trustPath,
    deploymentTrustRotationFile: rotationPath,
    clock: () => now,
    webAuth: {
      mode: "trusted-team",
      ownerRecoveryToken: recoveryToken,
      publicOrigin
    }
  });
  try {
    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Alice" }
    });
    const ownerHeaders = {
      cookie: responseCookie(setup),
      origin: publicOrigin
    };
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: ownerHeaders,
      payload: { name: "Rotation Team" }
    });
    const teamId = team.json().team.teamId as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: ownerHeaders,
      payload: {
        operationId: "op_createrotation0000000000000000001",
        claimSecret
      }
    });
    const pairingSessionId = created.json().pairingSessionId as string;
    const pairingAttemptId = "pairattempt_rotation0000000000000001";
    const claimed = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: {
        operationId: "op_claimrotation00000000000000000001",
        pairingSessionId,
        claimSecret,
        pairingAttemptId,
        pollSecret,
        device: {
          displayName: "Bob Windows",
          platform: "windows-amd64",
          bridgeVersion: "0.4.0-qa028.1",
          supportsScopedPrivateTrust: true
        },
        trust
      }
    });
    assert.equal(claimed.statusCode, 200);
    const approved = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: ownerHeaders,
      payload: {
        operationId: "op_approverotation000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(approved.statusCode, 200);
    const consumed = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/poll`,
      payload: { pairingSessionId, pairingAttemptId, pollSecret }
    });
    assert.equal(consumed.statusCode, 200);
    assert.equal(consumed.json().state, "consumed");
    const deviceHeaders = { authorization: `Bearer ${pollSecret}` };
    const offered = await app.inject({
      method: "GET",
      url: "/api/bridge/private-ca-rotation",
      headers: deviceHeaders
    });
    assert.equal(offered.statusCode, 200);
    assert.equal(offered.json().nextTrust.caCertificateSha256, rotationDigest);
    assert.doesNotMatch(JSON.stringify(offered.json()), /PRIVATE KEY/u);

    const acknowledgement = {
      operationId: "op_ackrotation0000000000000000000001",
      expectedCurrentTrustEpoch: 1,
      acceptedNextTrustEpoch: 2,
      caCertificateSha256: rotationDigest
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const acknowledged = await app.inject({
        method: "POST",
        url: "/api/bridge/private-ca-rotation/acknowledge",
        headers: deviceHeaders,
        payload: acknowledgement
      });
      assert.equal(acknowledged.statusCode, 204);
    }
    const mismatch = await app.inject({
      method: "POST",
      url: "/api/bridge/private-ca-rotation/acknowledge",
      headers: deviceHeaders,
      payload: { ...acknowledgement, operationId: "op_different000000000000000000000001" }
    });
    assert.equal(mismatch.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("public pairing rejects an unsolicited private trust descriptor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-public-pairing-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now
  });
  try {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    const authorization = `Bearer ${bootstrap.json().session.token}`;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Public Team" }
    });
    const teamId = team.json().team.teamId as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: { authorization },
      payload: {
        operationId: "op_createpublic000000000000000000001",
        claimSecret
      }
    });
    assert.equal(created.json().trust, undefined);
    const pairingSessionId = created.json().pairingSessionId as string;
    const claimed = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: {
        operationId: "op_claimpublic0000000000000000000001",
        pairingSessionId,
        claimSecret,
        pairingAttemptId: "pairattempt_public000000000000000001",
        pollSecret,
        device: {
          displayName: "Bob Windows",
          platform: "windows-amd64",
          bridgeVersion: "0.4.0-qa028.1",
          supportsScopedPrivateTrust: true
        },
        trust
      }
    });
    assert.equal(claimed.statusCode, 400);
  } finally {
    await app.close();
  }
});
