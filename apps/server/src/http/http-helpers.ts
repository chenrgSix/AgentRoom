import type { FastifyReply, FastifyRequest } from "fastify";

import {
  AuthorizationError,
  type IssuedCredential
} from "../security/auth-service.js";

export const trustedSessionCookie = "__Host-agentroom_session";
export const unsafeHttpMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return /^(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/iu.test(host) ||
    /^\[::1\](?::[0-9]{1,5})?$/u.test(host);
}

export function cookieValue(
  request: FastifyRequest,
  name: string
): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

export function sessionCookie(credential: IssuedCredential): string {
  if (!credential.expiresAt) throw new Error("Web session expiry is required");
  return [
    `${trustedSessionCookie}=${credential.secret}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Expires=${new Date(credential.expiresAt).toUTCString()}`
  ].join("; ");
}

export function clearSessionCookie(): string {
  return [
    `${trustedSessionCookie}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ].join("; ");
}

export function noStore(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
}

export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new Error("Request body must be a JSON object");
  }
  return request.body as Record<string, unknown>;
}

export function requiredString(
  value: unknown,
  label: string,
  maximum = 80
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

export function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

export function queryBoolean(value: string | undefined, label: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${label} must be true or false`);
}

export function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new AuthorizationError("UNAUTHENTICATED", "Bearer session required");
  }
  return authorization.slice(7);
}
