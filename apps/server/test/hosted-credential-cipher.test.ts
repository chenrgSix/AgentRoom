import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostedCredentialKeyring,
  decryptHostedCredential,
  encryptHostedCredential,
  HostedCredentialDecryptionError,
  unwrapHostedCredentialDataKey
} from "../src/security/hosted-credential-cipher.js";

const root = "owner-recovery-token-0123456789abcdef";
const scope = {
  credentialId: "hostedcred_0123456789abcdef",
  agentId: "agent_0123456789abcdef",
  teamId: "team_0123456789abcdef",
  provider: "openai_responses" as const,
  keyVersion: 1
};

test("Hosted credential envelopes round-trip without storing plaintext", () => {
  const keyring = createHostedCredentialKeyring(root, scope.keyVersion);
  const dataKey = unwrapHostedCredentialDataKey(
    root,
    scope.keyVersion,
    keyring.wrapped
  );
  const apiKey = "sk-proj-super-secret-value";
  const encrypted = encryptHostedCredential(apiKey, dataKey, scope);

  assert.equal(decryptHostedCredential(encrypted, dataKey, scope), apiKey);
  assert.doesNotMatch(
    JSON.stringify({
      wrapped: Object.fromEntries(Object.entries(keyring.wrapped).map(
        ([key, value]) => [key, Buffer.isBuffer(value) ? value.toString("base64") : value]
      )),
      encrypted: Object.fromEntries(Object.entries(encrypted).map(
        ([key, value]) => [key, Buffer.isBuffer(value) ? value.toString("base64") : value]
      ))
    }),
    /super-secret/u
  );
});

test("Hosted credential envelopes fail closed for tampering and wrong authority", () => {
  const keyring = createHostedCredentialKeyring(root, scope.keyVersion);
  const dataKey = keyring.dataKey;
  const encrypted = encryptHostedCredential("sk-private-credential", dataKey, scope);

  const tampered = {
    ...encrypted,
    ciphertext: Buffer.from(encrypted.ciphertext)
  };
  tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1;
  assert.throws(
    () => decryptHostedCredential(tampered, dataKey, scope),
    HostedCredentialDecryptionError
  );
  assert.throws(
    () => decryptHostedCredential(encrypted, dataKey, {
      ...scope,
      teamId: "team_otheridentity"
    }),
    HostedCredentialDecryptionError
  );
  assert.throws(
    () => unwrapHostedCredentialDataKey(
      "different-owner-recovery-token-abcdef0123456789",
      scope.keyVersion,
      keyring.wrapped
    ),
    HostedCredentialDecryptionError
  );
});

test("Hosted credential validation rejects control characters and bad keys", () => {
  const keyring = createHostedCredentialKeyring(root, scope.keyVersion);
  assert.throws(
    () => encryptHostedCredential("sk-key\nforged", keyring.dataKey, scope),
    /16 to 512 bytes/u
  );
  assert.throws(
    () => encryptHostedCredential("sk-valid-credential", Buffer.alloc(31), scope),
    /32 bytes/u
  );
});
