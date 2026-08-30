import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes
} from "node:crypto";

const algorithm = "aes-256-gcm";
const keyLength = 32;
const nonceLength = 12;
const tagLength = 16;
const wrappingInfo = Buffer.from(
  "convenewire/hosted-agent/kek/v1",
  "utf8"
);

export const hostedCredentialCipher = "aes-256-gcm" as const;
export const hostedCredentialKdf = "hkdf-sha256" as const;

export interface HostedWrappedDataKey {
  cipher: typeof hostedCredentialCipher;
  kdf: typeof hostedCredentialKdf;
  kdfSalt: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface HostedCredentialEnvelope {
  cipher: typeof hostedCredentialCipher;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export interface HostedCredentialScope {
  credentialId: string;
  agentId: string;
  teamId: string;
  provider: "openai_responses";
  keyVersion: number;
}

export interface NewHostedCredentialKeyring {
  dataKey: Buffer;
  wrapped: HostedWrappedDataKey;
}

export class HostedCredentialDecryptionError extends Error {
  public constructor() {
    super("Hosted credential could not be decrypted");
    this.name = "HostedCredentialDecryptionError";
  }
}

function requireRootSecret(rootSecret: Buffer | string): Buffer {
  const source = Buffer.isBuffer(rootSecret)
    ? Buffer.from(rootSecret)
    : Buffer.from(rootSecret, "utf8");
  if (source.byteLength < 32 || source.byteLength > 512) {
    throw new Error("Hosted credential root must contain 32 to 512 bytes");
  }
  return source;
}

function requireDataKey(dataKey: Buffer): Buffer {
  if (dataKey.byteLength !== keyLength) {
    throw new Error("Hosted credential data key must contain 32 bytes");
  }
  return Buffer.from(dataKey);
}

function deriveWrappingKey(
  rootSecret: Buffer | string,
  salt: Buffer
): Buffer {
  if (salt.byteLength !== keyLength) {
    throw new Error("Hosted credential KDF salt must contain 32 bytes");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    requireRootSecret(rootSecret),
    salt,
    wrappingInfo,
    keyLength
  ));
}

function wrapAad(keyVersion: number): Buffer {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error("Hosted credential key version is invalid");
  }
  return Buffer.from(
    `convenewire/hosted-agent/keyring/v1\0${keyVersion}`,
    "utf8"
  );
}

function credentialAad(scope: HostedCredentialScope): Buffer {
  if (
    !scope.credentialId.startsWith("hostedcred_") ||
    !scope.agentId.startsWith("agent_") ||
    !scope.teamId.startsWith("team_") ||
    scope.provider !== "openai_responses" ||
    !Number.isSafeInteger(scope.keyVersion) ||
    scope.keyVersion < 1
  ) {
    throw new Error("Hosted credential scope is invalid");
  }
  return Buffer.from([
    "convenewire/hosted-agent/credential/v1",
    scope.credentialId,
    scope.agentId,
    scope.teamId,
    scope.provider,
    String(scope.keyVersion)
  ].join("\0"), "utf8");
}

function encrypt(
  plaintext: Buffer,
  key: Buffer,
  aad: Buffer,
  nonce = randomBytes(nonceLength)
): { nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  if (nonce.byteLength !== nonceLength) {
    throw new Error("Hosted credential nonce must contain 12 bytes");
  }
  const cipher = createCipheriv(algorithm, key, nonce, { authTagLength: tagLength });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: Buffer.from(nonce),
    ciphertext,
    tag: cipher.getAuthTag()
  };
}

function decrypt(
  envelope: { nonce: Buffer; ciphertext: Buffer; tag: Buffer },
  key: Buffer,
  aad: Buffer
): Buffer {
  if (
    envelope.nonce.byteLength !== nonceLength ||
    envelope.tag.byteLength !== tagLength
  ) {
    throw new HostedCredentialDecryptionError();
  }
  try {
    const decipher = createDecipheriv(algorithm, key, envelope.nonce, {
      authTagLength: tagLength
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final()
    ]);
  } catch {
    throw new HostedCredentialDecryptionError();
  }
}

export function createHostedCredentialKeyring(
  rootSecret: Buffer | string,
  keyVersion: number
): NewHostedCredentialKeyring {
  const dataKey = randomBytes(keyLength);
  const kdfSalt = randomBytes(keyLength);
  const encrypted = encrypt(
    dataKey,
    deriveWrappingKey(rootSecret, kdfSalt),
    wrapAad(keyVersion)
  );
  return {
    dataKey,
    wrapped: {
      cipher: hostedCredentialCipher,
      kdf: hostedCredentialKdf,
      kdfSalt,
      ...encrypted
    }
  };
}

export function unwrapHostedCredentialDataKey(
  rootSecret: Buffer | string,
  keyVersion: number,
  wrapped: HostedWrappedDataKey
): Buffer {
  if (
    wrapped.cipher !== hostedCredentialCipher ||
    wrapped.kdf !== hostedCredentialKdf
  ) {
    throw new HostedCredentialDecryptionError();
  }
  try {
    return requireDataKey(decrypt(
      wrapped,
      deriveWrappingKey(rootSecret, wrapped.kdfSalt),
      wrapAad(keyVersion)
    ));
  } catch (error) {
    if (error instanceof HostedCredentialDecryptionError) throw error;
    throw new HostedCredentialDecryptionError();
  }
}

export function encryptHostedCredential(
  apiKey: string,
  dataKey: Buffer,
  scope: HostedCredentialScope
): HostedCredentialEnvelope {
  const bytes = Buffer.from(apiKey, "utf8");
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > 512 ||
    /[\u0000\r\n]/u.test(apiKey)
  ) {
    throw new Error("Hosted provider credential must contain 1 to 512 bytes");
  }
  return {
    cipher: hostedCredentialCipher,
    ...encrypt(bytes, requireDataKey(dataKey), credentialAad(scope))
  };
}

export function decryptHostedCredential(
  envelope: HostedCredentialEnvelope,
  dataKey: Buffer,
  scope: HostedCredentialScope
): string {
  if (envelope.cipher !== hostedCredentialCipher) {
    throw new HostedCredentialDecryptionError();
  }
  return decrypt(
    envelope,
    requireDataKey(dataKey),
    credentialAad(scope)
  ).toString("utf8");
}
