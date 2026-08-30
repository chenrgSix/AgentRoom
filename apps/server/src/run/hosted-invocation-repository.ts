import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRecord, RunRepository, RunState } from "./run-repository.js";

export type HostedInvocationState =
  | "prepared"
  | "dispatching"
  | "streaming"
  | "completed"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export interface HostedInvocationRecord {
  invocationId: string;
  runId: string;
  teamId: string;
  agentId: string;
  profileRevision: number;
  credentialVersion: number;
  provider: "openai_responses";
  model: string;
  deadlineAt: string;
  promptSha256: string;
  idempotencyKey: string;
  state: HostedInvocationState;
  failureCode: string | null;
  preparedAt: string;
  dispatchedAt: string | null;
  streamingAt: string | null;
  cancellationRequestedAt: string | null;
  cancellationRequestedByMemberId: string | null;
  cancellationReason: string | null;
  terminalAt: string | null;
  updatedAt: string;
}

export interface HostedInvocationRecovery {
  runnableRunIds: string[];
  outcomeUnknownRunIds: string[];
  reconciledRunIds: string[];
}

interface InvocationRow {
  invocation_id: string;
  run_id: string;
  team_id: string;
  agent_id: string;
  profile_revision: number;
  credential_version: number;
  provider: "openai_responses";
  model: string;
  deadline_at: string;
  prompt_sha256: string;
  idempotency_key: string;
  state: HostedInvocationState;
  failure_code: string | null;
  prepared_at: string;
  dispatched_at: string | null;
  streaming_at: string | null;
  cancellation_requested_at: string | null;
  cancellation_requested_by_member_id: string | null;
  cancellation_reason: string | null;
  terminal_at: string | null;
  updated_at: string;
}

const invocationTerminalStates = new Set<HostedInvocationState>([
  "completed",
  "failed",
  "canceled",
  "outcome_unknown"
]);

const runTerminalStates = new Set<RunState>([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

function mapInvocation(row: InvocationRow): HostedInvocationRecord {
  return {
    invocationId: row.invocation_id,
    runId: row.run_id,
    teamId: row.team_id,
    agentId: row.agent_id,
    profileRevision: row.profile_revision,
    credentialVersion: row.credential_version,
    provider: row.provider,
    model: row.model,
    deadlineAt: row.deadline_at,
    promptSha256: row.prompt_sha256,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    failureCode: row.failure_code,
    preparedAt: row.prepared_at,
    dispatchedAt: row.dispatched_at,
    streamingAt: row.streaming_at,
    cancellationRequestedAt: row.cancellation_requested_at,
    cancellationRequestedByMemberId: row.cancellation_requested_by_member_id,
    cancellationReason: row.cancellation_reason,
    terminalAt: row.terminal_at,
    updatedAt: row.updated_at
  };
}

function closedFailureCode(value: string): string {
  if (!/^[A-Z0-9_]{1,80}$/u.test(value)) {
    return "HOSTED_INVOCATION_FAILED";
  }
  return value;
}

export class HostedInvocationRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly runs: RunRepository,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public getByRun(runId: string): HostedInvocationRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM hosted_invocation_intents WHERE run_id = ?
    `).get(runId) as InvocationRow | undefined;
    return row && mapInvocation(row);
  }

  public prepare(input: {
    runId: string;
    teamId: string;
    agentId: string;
    profileRevision: number;
    credentialVersion: number;
    provider: "openai_responses";
    model: string;
    deadlineAt: string;
    promptSha256: string;
    now: string;
  }): HostedInvocationRecord {
    return this.transactions.immediate(() => {
      const existing = this.getByRun(input.runId);
      if (existing) {
        if (
          existing.teamId !== input.teamId ||
          existing.agentId !== input.agentId ||
          existing.profileRevision !== input.profileRevision ||
          existing.credentialVersion !== input.credentialVersion ||
          existing.provider !== input.provider ||
          existing.model !== input.model ||
          existing.deadlineAt !== input.deadlineAt ||
          existing.promptSha256 !== input.promptSha256
        ) {
          throw new Error("Hosted invocation intent does not match its Run");
        }
        return existing;
      }
      const invocationId = createOpaqueId("hostedinv");
      this.database.prepare(`
        INSERT INTO hosted_invocation_intents (
          invocation_id, run_id, team_id, agent_id, profile_revision,
          credential_version, provider, model, deadline_at, prompt_sha256,
          idempotency_key, state, failure_code, prepared_at, dispatched_at,
          streaming_at, cancellation_requested_at,
          cancellation_requested_by_member_id, cancellation_reason,
          terminal_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, NULL, NULL,
          NULL, NULL, NULL, NULL, ?
        )
      `).run(
        invocationId,
        input.runId,
        input.teamId,
        input.agentId,
        input.profileRevision,
        input.credentialVersion,
        input.provider,
        input.model,
        input.deadlineAt,
        input.promptSha256,
        `hosted-invocation:${input.runId}`,
        input.now,
        input.now
      );
      return this.getByRun(input.runId)!;
    });
  }

  public markDispatching(runId: string, now: string): HostedInvocationRecord {
    return this.transactions.immediate(() => {
      const invocation = this.require(runId);
      if (invocation.state !== "prepared") return invocation;
      const run = this.requireRun(runId);
      if (run.state !== "queued") {
        throw new Error(`Hosted Run cannot dispatch from state: ${run.state}`);
      }
      if (Date.parse(run.deadlineAt) <= Date.parse(now)) {
        this.runs.applyEvent(runId, {
          type: "status",
          sequence: run.lastSequence + 1,
          status: "expired",
          error: {
            code: "RUN_EXPIRED",
            message: "Run expired before its target Agent accepted delivery.",
            retryable: false
          }
        }, now);
        this.database.prepare(`
          UPDATE hosted_invocation_intents
          SET state = 'failed',
            failure_code = 'HOSTED_RUN_EXPIRED_PRE_DISPATCH',
            terminal_at = ?, updated_at = ?
          WHERE run_id = ? AND state = 'prepared'
        `).run(now, now, runId);
        return this.getByRun(runId)!;
      }
      const changed = this.database.prepare(`
        UPDATE hosted_invocation_intents
        SET state = 'dispatching', dispatched_at = ?, updated_at = ?
        WHERE run_id = ? AND state = 'prepared'
      `).run(now, now, runId);
      if (changed.changes !== 1) {
        throw new Error("Hosted invocation dispatch fence changed");
      }
      this.runs.applyEvent(runId, {
        type: "status",
        sequence: run.lastSequence + 1,
        status: "delivered"
      }, now);
      return this.getByRun(runId)!;
    });
  }

  public markStreaming(runId: string, now: string): HostedInvocationRecord {
    return this.transactions.immediate(() => {
      const invocation = this.require(runId);
      if (invocation.state === "streaming" ||
          invocationTerminalStates.has(invocation.state)) {
        return invocation;
      }
      if (invocation.state !== "dispatching") {
        throw new Error("Hosted invocation cannot enter streaming");
      }
      this.database.prepare(`
        UPDATE hosted_invocation_intents
        SET state = 'streaming', streaming_at = ?, updated_at = ?
        WHERE run_id = ? AND state = 'dispatching'
      `).run(now, now, runId);
      return this.getByRun(runId)!;
    });
  }

  public requestCancellation(input: {
    runId: string;
    memberId: string;
    reason: string;
    now: string;
  }): HostedInvocationRecord | undefined {
    return this.transactions.immediate(() => {
      const invocation = this.getByRun(input.runId);
      if (!invocation || invocationTerminalStates.has(invocation.state)) {
        return invocation;
      }
      if (invocation.cancellationRequestedAt !== null) return invocation;
      this.database.prepare(`
        UPDATE hosted_invocation_intents
        SET cancellation_requested_at = ?,
          cancellation_requested_by_member_id = ?, cancellation_reason = ?,
          updated_at = ?
        WHERE run_id = ? AND cancellation_requested_at IS NULL
      `).run(input.now, input.memberId, input.reason, input.now, input.runId);
      return this.getByRun(input.runId)!;
    });
  }

  public cancelPrepared(input: {
    runId: string;
    memberId: string;
    reason: string;
    now: string;
  }): RunRecord {
    return this.transactions.immediate(() => {
      const invocation = this.require(input.runId);
      const run = this.requireRun(input.runId);
      if (invocation.state !== "prepared") {
        throw new Error("Hosted invocation already crossed its dispatch fence");
      }
      if (run.state !== "queued") {
        throw new Error("Prepared Hosted Run is not queued");
      }
      this.requestCancellation(input);
      const canceled = this.runs.applyEvent(input.runId, {
        type: "status",
        sequence: run.lastSequence + 1,
        status: "canceled",
        error: {
          code: "HOSTED_RUN_CANCELED_PRE_DISPATCH",
          message: "Hosted Run was canceled before provider dispatch.",
          retryable: false
        }
      }, input.now).run;
      this.database.prepare(`
        UPDATE hosted_invocation_intents
        SET state = 'canceled',
          failure_code = 'HOSTED_RUN_CANCELED_PRE_DISPATCH',
          terminal_at = ?, updated_at = ?
        WHERE run_id = ? AND state = 'prepared'
          AND cancellation_requested_at IS NOT NULL
      `).run(input.now, input.now, input.runId);
      return canceled;
    });
  }

  public settleFromRun(runId: string, failureCode: string, now: string):
    HostedInvocationRecord {
    return this.transactions.immediate(() => {
      const invocation = this.require(runId);
      if (invocationTerminalStates.has(invocation.state)) return invocation;
      const run = this.requireRun(runId);
      if (!runTerminalStates.has(run.state)) {
        throw new Error("Hosted invocation cannot settle before its Run");
      }
      const state = run.state === "canceled" && invocation.state !== "prepared"
        ? "outcome_unknown"
        : this.invocationState(run);
      const code = state === "completed" ? null : closedFailureCode(failureCode);
      this.database.prepare(`
        UPDATE hosted_invocation_intents
        SET state = ?, failure_code = ?, terminal_at = ?, updated_at = ?
        WHERE run_id = ? AND state IN ('prepared', 'dispatching', 'streaming')
      `).run(state, code, now, now, runId);
      return this.getByRun(runId)!;
    });
  }

  public listRunnableQueuedRunIds(): string[] {
    return (this.database.prepare(`
      SELECT run.run_id
      FROM runs run
      JOIN agents agent ON agent.agent_id = run.target_agent_id
      LEFT JOIN hosted_invocation_intents invocation
        ON invocation.run_id = run.run_id
      WHERE run.state = 'queued'
        AND agent.integration_mode = 'hosted'
        AND agent.enabled = 1
        AND (invocation.run_id IS NULL OR invocation.state = 'prepared')
        AND invocation.cancellation_requested_at IS NULL
      ORDER BY run.created_at, run.run_id
    `).all() as Array<{ run_id: string }>).map((row) => row.run_id);
  }

  public recover(now: string): HostedInvocationRecovery {
    return this.transactions.immediate(() => {
      const runnableRunIds: string[] = [];
      const outcomeUnknownRunIds: string[] = [];
      const reconciledRunIds: string[] = [];
      const rows = this.database.prepare(`
        SELECT * FROM hosted_invocation_intents
        WHERE state IN ('prepared', 'dispatching', 'streaming')
        ORDER BY prepared_at, invocation_id
      `).all() as InvocationRow[];
      for (const row of rows) {
        const invocation = mapInvocation(row);
        const run = this.runs.getRun(invocation.runId);
        if (!run) throw new Error("Hosted invocation Run is unavailable");
        if (runTerminalStates.has(run.state)) {
          this.settleFromRun(
            run.runId,
            run.state === "expired"
              ? "HOSTED_RUN_EXPIRED_PRE_DISPATCH"
              : `HOSTED_RUN_${run.state.toUpperCase()}`,
            now
          );
          reconciledRunIds.push(run.runId);
          continue;
        }
        if (
          invocation.state === "prepared" &&
          invocation.cancellationRequestedAt &&
          invocation.cancellationRequestedByMemberId &&
          invocation.cancellationReason
        ) {
          this.cancelPrepared({
            runId: run.runId,
            memberId: invocation.cancellationRequestedByMemberId,
            reason: invocation.cancellationReason,
            now
          });
          reconciledRunIds.push(run.runId);
          continue;
        }
        if (invocation.state === "prepared" && run.state === "queued") {
          runnableRunIds.push(run.runId);
          continue;
        }
        const unknown = this.runs.applyEvent(run.runId, {
          type: "status",
          sequence: run.lastSequence + 1,
          status: "outcome_unknown",
          error: {
            code: "HOSTED_SERVER_RESTART_UNKNOWN",
            message: "Central restarted after the Hosted provider dispatch fence.",
            retryable: false
          }
        }, now).run;
        if (invocation.state === "prepared") {
          // A prepared intent cannot move directly to outcome_unknown. This is
          // a fail-closed reconciliation of an impossible partial acceptance.
          this.database.prepare(`
            UPDATE hosted_invocation_intents
            SET state = 'failed', failure_code = 'HOSTED_DISPATCH_FENCE_INVALID',
              terminal_at = ?, updated_at = ?
            WHERE run_id = ? AND state = 'prepared'
          `).run(now, now, run.runId);
        } else {
          this.settleFromRun(
            unknown.runId,
            "HOSTED_SERVER_RESTART_UNKNOWN",
            now
          );
        }
        outcomeUnknownRunIds.push(run.runId);
      }

      const orphaned = this.database.prepare(`
        SELECT run.run_id
        FROM runs run
        JOIN agents agent ON agent.agent_id = run.target_agent_id
        LEFT JOIN hosted_invocation_intents invocation
          ON invocation.run_id = run.run_id
        WHERE agent.integration_mode = 'hosted'
          AND run.state IN ('delivered', 'working')
          AND invocation.run_id IS NULL
        ORDER BY run.created_at, run.run_id
      `).all() as Array<{ run_id: string }>;
      for (const { run_id: runId } of orphaned) {
        const run = this.requireRun(runId);
        this.runs.applyEvent(runId, {
          type: "status",
          sequence: run.lastSequence + 1,
          status: "outcome_unknown",
          error: {
            code: "HOSTED_INVOCATION_INTENT_MISSING",
            message: "Hosted provider acceptance could not be reconstructed.",
            retryable: false
          }
        }, now);
        outcomeUnknownRunIds.push(runId);
      }
      for (const runId of this.listRunnableQueuedRunIds()) {
        if (!runnableRunIds.includes(runId)) runnableRunIds.push(runId);
      }
      return { runnableRunIds, outcomeUnknownRunIds, reconciledRunIds };
    });
  }

  private require(runId: string): HostedInvocationRecord {
    const invocation = this.getByRun(runId);
    if (!invocation) throw new Error(`Hosted invocation not found: ${runId}`);
    return invocation;
  }

  private requireRun(runId: string): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }

  private invocationState(run: RunRecord): Extract<HostedInvocationState,
    "completed" | "failed" | "canceled" | "outcome_unknown"> {
    if (run.state === "completed") return "completed";
    if (run.state === "canceled") return "canceled";
    if (run.state === "outcome_unknown") return "outcome_unknown";
    return "failed";
  }
}
