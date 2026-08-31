import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { FastifyInstance, HTTPMethods } from "fastify";
import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanProposalCommand
} from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { createServerApp } from "../../src/app.js";
import { openDatabase } from "../../src/data/database.js";

export const now = "2026-08-31T12:00:00.000Z";
const fixtures = JSON.parse(await readFile(new URL(
  "../../../../packages/contracts/fixtures/execution-plan-cases.json", import.meta.url
), "utf8"));
const template = fixtures.cases.find((entry: { name: string }) =>
  entry.name === "execution: valid full plan").instance as ExecutionPlanDefinition;

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-execution-history-"));
  let app: FastifyInstance | undefined;
  const connections: ReturnType<typeof openDatabase>[] = [];
  // Register ownership cleanup before migrations or bootstrap can fail.
  t.after(async () => {
    try {
      for (const socket of app?.websocketServer.clients ?? []) socket.terminate();
      await app?.close();
    } finally {
      for (const connection of connections) if (connection.open) connection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const databasePath = path.join(directory, "server.sqlite");
  app = await createServerApp({ databasePath, clock: () => now, logger: false });
  let authorization = "";
  const request = (
    method: HTTPMethods, url: string, payload?: unknown, token = authorization
  ) => app!.inject({
    method, url, headers: { authorization: token },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
  const ok = async (method: HTTPMethods, url: string, payload?: unknown, token?: string) => {
    const response = await request(method, url, payload, token);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const bootstrap = await ok("POST", "/api/bootstrap", {
    userId: "user_execution_owner0001", displayName: "Owner"
  });
  authorization = `Bearer ${bootstrap.session.token}`;
  const team = await ok("POST", "/api/teams", { name: "Execution" });
  const teamId = team.team.teamId as string;
  const ownerMemberId = team.owner.memberId as string;
  const room = await ok("POST", `/api/teams/${teamId}/rooms`, { name: "plans" });
  const roomId = room.roomId as string;
  const createdAgent = await ok("POST", `/api/teams/${teamId}/manual-agents`, {
    name: "Builder", role: "Builder"
  });
  const agentId = createdAgent.agent.agentId as string;
  await ok("PUT", `/api/rooms/${roomId}/participants`, {
    memberIds: [ownerMemberId], agentIds: [agentId]
  });
  const root = await ok("POST", `/api/rooms/${roomId}/tasks`, {
    title: "Ship a scoped change", goal: "Preserve authority and history"
  });
  const message = (await ok("POST", `/api/rooms/${roomId}/messages`, {
    taskId: root.taskId, content: "Use the existing work model."
  })).message;
  const definition = structuredClone(template);
  definition.rootTaskId = root.taskId;
  definition.decision.sources = [{
    evidenceRefId: "evidence_original0001", kind: "message", messageId: message.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_original0001", revision: message.sequence
  }];
  for (const node of definition.nodes) {
    node.agentId = agentId;
    node.task.ownerMemberId = ownerMemberId;
  }
  // Message bookkeeping can advance other fields; use the current authoritative pin.
  const currentRoot = await ok("GET", `/api/tasks/${root.taskId}`);
  const command = (): ExecutionPlanProposalCommand => ({
    operationId: "op_execution_create0001",
    expectedRootTaskRevision: currentRoot.taskRevision,
    definition: structuredClone(definition)
  });
  const create = async (value = command()) => await ok(
    "POST", `/api/tasks/${root.taskId}/execution-plans`, value
  ) as ExecutionPlanProjection;
  const database = openDatabase(databasePath);
  connections.push(database);
  const counts = () => Object.fromEntries([
    "execution_plans", "execution_decisions", "execution_plan_proposals",
    "execution_plan_revisions", "execution_decision_sources", "execution_plan_operations",
    "execution_plan_approvals", "execution_plan_nodes", "execution_plan_edges",
    "execution_plan_task_claims", "execution_plan_drift_events", "task_mutation_operations",
    "task_definition_revisions", "task_criteria_revisions", "task_agent_assignments",
    "task_result_sources", "agent_tasks", "runs"
  ].map((table) => [table, (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]));
  return {
    app,
    request, ok, create, command, database, counts, root: currentRoot, roomId,
    teamId, ownerMemberId, agentId, message, authorization,
    async restart() {
      for (const socket of app!.websocketServer.clients) socket.terminate();
      await app!.close();
      app = undefined;
      app = await createServerApp({ databasePath, clock: () => now, logger: false });
    },
    async restartTrusted() {
      for (const socket of app!.websocketServer.clients) socket.terminate();
      await app!.close();
      app = undefined;
      app = await createServerApp({ databasePath, clock: () => now, logger: false, webAuth: {
        mode: "trusted-team", publicOrigin: "https://central.example",
        ownerRecoveryToken: "execution-test-recovery-" + "r".repeat(32)
      } });
      return app;
    },
    async participant() {
      const bootstrap = await ok("POST", "/api/bootstrap", {
        userId: "user_execution_member0001", displayName: "Member"
      });
      const member = await ok("POST", `/api/teams/${teamId}/members`, {
        userId: "user_execution_member0001", displayName: "Member"
      });
      await ok("PUT", `/api/rooms/${roomId}/participants`, {
        memberIds: [ownerMemberId, member.memberId], agentIds: [agentId]
      });
      return { memberId: member.memberId, authorization: `Bearer ${bootstrap.session.token}` };
    }
  };
}
