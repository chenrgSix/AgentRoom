import type Database from "better-sqlite3";
import type { ExecutionNodeRetryAuthorization } from
  "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import { ExecutionError } from "./execution-error.js";

interface RetryAuthorizationRow {
  authorization_json: string;
  request_digest: string;
}

type RetryAuthorizationUnsigned = Omit<
  ExecutionNodeRetryAuthorization,
  "authorizationDigest"
>;

function unsigned(
  authorization: ExecutionNodeRetryAuthorization
): RetryAuthorizationUnsigned {
  const { authorizationDigest: _authorizationDigest, ...value } = authorization;
  return value;
}

function validate(
  row: RetryAuthorizationRow
): ExecutionNodeRetryAuthorization {
  const authorization = JSON.parse(
    row.authorization_json
  ) as ExecutionNodeRetryAuthorization;
  assertExecutionCommand("nodeRetryAuthorization", authorization);
  if (
    authorization.requestDigest !== row.request_digest ||
    executionOperationDigest(unsigned(authorization)) !==
      authorization.authorizationDigest
  ) {
    throw new Error("Execution node retry authorization digest is invalid");
  }
  return authorization;
}

export class ExecutionNodeRetryRepository {
  public constructor(private readonly database: Database.Database) {}

  public replay(
    operationId: string,
    requestDigest: string
  ): ExecutionNodeRetryAuthorization | undefined {
    const row = this.database.prepare(`
      SELECT authorization_json, request_digest
      FROM execution_node_retry_authorizations
      WHERE operation_id = ?
    `).get(operationId) as RetryAuthorizationRow | undefined;
    if (!row) return undefined;
    if (row.request_digest !== requestDigest) {
      throw new ExecutionError("EXECUTION_NODE_RETRY_OPERATION_CONFLICT", 409);
    }
    return validate(row);
  }

  public retain(
    value: RetryAuthorizationUnsigned
  ): ExecutionNodeRetryAuthorization {
    const authorization: ExecutionNodeRetryAuthorization = {
      ...value,
      authorizationDigest: executionOperationDigest(value)
    };
    assertExecutionCommand("nodeRetryAuthorization", authorization);
    this.database.prepare(`
      INSERT INTO execution_node_retry_authorizations (
        operation_id, plan_id, plan_revision, plan_digest,
        plan_control_revision, node_key,
        previous_node_projection_revision, previous_generation,
        previous_run_id, previous_run_state,
        ambiguity_acknowledgement_operation_id, new_generation, new_run_id,
        new_dispatch_intent_id, requested_by_member_id, reason,
        request_digest, authorization_digest, authorization_json, created_at
      ) VALUES (
        @operationId, @planId, @planRevision, @planDigest,
        @planControlRevision, @nodeKey,
        @previousNodeProjectionRevision, @previousGeneration,
        @previousRunId, @previousRunState,
        @ambiguityAcknowledgementOperationId, @newGeneration, @newRunId,
        @newDispatchIntentId, @requestedByMemberId, @reason,
        @requestDigest, @authorizationDigest, @authorizationJson, @createdAt
      )
    `).run({
      ...authorization,
      authorizationJson: canonicalExecutionJSON(authorization)
    });
    return authorization;
  }

  public hasMaterialization(
    planId: string,
    planRevision: number,
    nodeKey: string
  ): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM execution_evidence_adoptions materialization
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
      LIMIT 1
    `).get(planId, planRevision, nodeKey));
  }
}
