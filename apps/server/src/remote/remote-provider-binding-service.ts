import type {
  RemoteProviderBinding,
  RemoteProviderBindingRevocation
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest,
  remoteProviderBindingDigest,
  remoteProviderBindingRevocationDigest
} from "@convene-wire/contracts/execution-validation";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import { ExecutionError } from "../execution/execution-error.js";
import type {
  RemoteProviderBindingRepository,
  StoredRemoteProviderBinding
} from "./remote-provider-binding-repository.js";

interface CreateRemoteProviderBindingCommand {
  operationId: string;
  repositoryId: string;
  providerOrigin: string;
  providerRepositoryId: string;
  ciChecks: RemoteProviderBinding["ciChecks"];
}

interface RevokeRemoteProviderBindingCommand {
  operationId: string;
  expectedBindingDigest: string;
  reason: string;
}

const fail = (code: string, statusCode: 400 | 404 | 409 = 409): never => {
  throw new ExecutionError(code, statusCode);
};

function exactKeys(value: unknown, keys: readonly string[], code: string):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) fail(code, 400);
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string") return fail("REMOTE_PROVIDER_BINDING_INVALID", 400);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail("REMOTE_PROVIDER_BINDING_INVALID", 400);
  }
  if (value !== parsed.origin) return fail("REMOTE_PROVIDER_BINDING_INVALID", 400);
  return value;
}

/** Owns metadata-only provider consent; it never resolves or stores credentials. */
export class RemoteProviderBindingService {
  public constructor(
    private readonly repository: RemoteProviderBindingRepository,
    private readonly auth: AuthService,
    private readonly allowTestLoopbackOrigin = false
  ) {}

  public create(
    principal: WebPrincipal,
    teamId: string,
    input: unknown,
    now: string
  ): StoredRemoteProviderBinding {
    this.auth.requireFullWebSession(principal);
    const actor = this.auth.requireTeamMember(principal, teamId);
    if (actor.role !== "owner") {
      throw new AuthorizationError("FORBIDDEN", "Only a Team owner can configure remote evidence");
    }
    exactKeys(input, [
      "operationId", "repositoryId", "providerOrigin",
      "providerRepositoryId", "ciChecks"
    ], "REMOTE_PROVIDER_BINDING_INVALID");
    canonicalExecutionJSON(input);
    const command = input as unknown as CreateRemoteProviderBindingCommand;
    const origin = canonicalOrigin(command.providerOrigin);
    const parsedOrigin = new URL(origin);
    const testLoopbackHTTP = parsedOrigin.protocol === "http:" &&
      (parsedOrigin.hostname === "127.0.0.1" || parsedOrigin.hostname === "[::1]");
    if (parsedOrigin.protocol !== "https:" &&
      !(this.allowTestLoopbackOrigin && testLoopbackHTTP)) {
      return fail("REMOTE_PROVIDER_BINDING_INVALID", 400);
    }
    const requestDigest = executionOperationDigest({
      ...command,
      providerOrigin: origin,
      teamId,
      actorMemberId: actor.memberId
    });
    const replay = this.repository.getByOperation(command.operationId);
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        return fail("REMOTE_PROVIDER_OPERATION_CONFLICT");
      }
      return replay;
    }
    const keyDigest = executionOperationDigest({
      operationId: command.operationId,
      teamId,
      repositoryId: command.repositoryId,
      providerOrigin: origin,
      providerRepositoryId: command.providerRepositoryId
    });
    const pending: RemoteProviderBinding = {
      version: 1,
      providerBindingId: `provider_${keyDigest}`,
      teamId,
      repositoryId: command.repositoryId,
      providerOrigin: origin,
      providerRepositoryId: command.providerRepositoryId,
      ciChecks: (Array.isArray(command.ciChecks)
        ? [...command.ciChecks].sort((left, right) =>
          left.checkKey < right.checkKey ? -1 : left.checkKey > right.checkKey ? 1 : 0)
        : command.ciChecks) as RemoteProviderBinding["ciChecks"],
      createdByMemberId: actor.memberId,
      bindingDigest: "0".repeat(64),
      createdAt: now
    };
    pending.bindingDigest = remoteProviderBindingDigest(pending);
    assertExecutionCommand("remoteProviderBinding", pending);
    const stored = this.repository.insert(pending, command.operationId, requestDigest);
    if (stored.requestDigest !== requestDigest ||
      canonicalExecutionJSON(stored.binding) !== canonicalExecutionJSON(pending)) {
      return fail("REMOTE_PROVIDER_OPERATION_CONFLICT");
    }
    return stored;
  }

  public list(
    principal: WebPrincipal,
    teamId: string
  ): StoredRemoteProviderBinding[] {
    this.auth.requireTeamMember(principal, teamId);
    return this.repository.list(teamId);
  }

  public revoke(
    principal: WebPrincipal,
    providerBindingId: string,
    input: unknown,
    now: string
  ): StoredRemoteProviderBinding {
    this.auth.requireFullWebSession(principal);
    const stored = this.repository.get(providerBindingId);
    if (!stored) return fail("REMOTE_PROVIDER_BINDING_NOT_FOUND", 404);
    const actor = this.auth.requireTeamMember(principal, stored.binding.teamId);
    if (actor.role !== "owner") {
      throw new AuthorizationError("FORBIDDEN", "Only a Team owner can revoke remote evidence");
    }
    exactKeys(input, ["operationId", "expectedBindingDigest", "reason"],
      "REMOTE_PROVIDER_REVOCATION_INVALID");
    canonicalExecutionJSON(input);
    const command = input as unknown as RevokeRemoteProviderBindingCommand;
    if (command.expectedBindingDigest !== stored.binding.bindingDigest) {
      return fail("REMOTE_PROVIDER_BINDING_STALE");
    }
    if (stored.revocation) {
      if (
        stored.revocation.operationId === command.operationId &&
        stored.revocation.expectedBindingDigest === command.expectedBindingDigest &&
        stored.revocation.reason === command.reason &&
        stored.revocation.revokedByMemberId === actor.memberId
      ) return stored;
      return fail("REMOTE_PROVIDER_ALREADY_REVOKED");
    }
    const revocation: RemoteProviderBindingRevocation = {
      version: 1,
      operationId: command.operationId,
      providerBindingId,
      expectedBindingDigest: command.expectedBindingDigest,
      revokedByMemberId: actor.memberId,
      reason: command.reason,
      revocationDigest: "0".repeat(64),
      revokedAt: now
    };
    revocation.revocationDigest = remoteProviderBindingRevocationDigest(revocation);
    assertExecutionCommand("remoteProviderBindingRevocation", revocation);
    return this.repository.revoke(revocation);
  }
}
