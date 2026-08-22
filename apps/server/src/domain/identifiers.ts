import { randomBytes } from "node:crypto";

export function createOpaqueId(prefix: string): string {
  if (!/^[a-z][a-z0-9]*$/u.test(prefix)) {
    throw new Error(`Invalid identifier prefix: ${prefix}`);
  }
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}
