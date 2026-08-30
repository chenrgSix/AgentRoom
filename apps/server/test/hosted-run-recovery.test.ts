import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { HostedAgentRepository, hostedProvider } from
  "../src/data/hosted-agent-repository.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import {
  HostedAgentConfigurationService
} from "../src/hosted/hosted-agent-configuration-service.js";
import { AgentService } from "../src/registry/agent-service.js";
import { HostedInvocationRepository } from
  "../src/run/hosted-invocation-repository.js";
import {
  HostedRunScheduler,
  type HostedRunSchedulerOptions
} from "../src/run/hosted-run-scheduler.js";
import { MemberMessageRunService } from
  "../src/run/member-message-run-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import {
  HostedOpenAIResponsesAdapter
} from "../src/runtime/hosted-openai-responses-adapter.js";
import { InProcessRunExecutor } from
  "../src/runtime/in-process-run-executor.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-30T05:00:00.000Z";
const later = "2026-08-30T05:00:01.000Z";
const apiKey = "sk-hosted-recovery-ABCDEFGHIJKLMNOP";

function frame(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function providerResponse(text: string): Response {
  const responseId = "resp_hosted_recovery_123";
  const message = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }]
  };
  return new Response([
    frame("response.created", {
      response: { id: responseId, status: "in_progress" }
    }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { type: "message", role: "assistant", content: [] }
    }),
    frame("response.content_part.added", {
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" }
    }),
    frame("response.output_text.delta", {
      output_index: 0,
      content_index: 0,
      delta: text
    }),
    frame("response.output_text.done", {
      output_index: 0,
      content_index: 0,
      text
    }),
    frame("response.content_part.done", {
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text }
    }),
    frame("response.output_item.done", { output_index: 0, item: message }),
    frame("response.completed", {
      response: {
        id: responseId,
        status: "completed",
        output: [message]
      }
    })
  ].join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

async function createPreparedFixture(label: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), label));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const created = teams.createTeamForUser({
    userId: `user_${label.replaceAll("-", "_")}12345678`,
    userDisplayName: "Alice",
    teamName: "Hosted Recovery",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-31T05:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const hostedAgents = new HostedAgentRepository(
    database,
    { mode: "local_database" },
    transactions
  );
  const agentService = new AgentService(core, auth);
  const configuration = new HostedAgentConfigurationService(
    hostedAgents,
    core,
    agentService,
    auth,
    transactions,
    { async test() { return { status: "ready" as const }; } }
  );
  const agent = await configuration.create(principal, {
    teamId: created.team.teamId,
    name: "Central Recovery Agent",
    role: "Remote model",
    provider: hostedProvider,
    model: "gpt-recovery-test",
    apiKey,
    roomIds: [room.roomId],
    now
  });
  const messages = new MessageService(core, auth);
  const runs = new RunRepository(database, transactions);
  const tasks = new AgentTaskRepository(database);
  const runService = new RunService(core, runs, auth, tasks);
  const memberMessageRuns = new MemberMessageRunService(
    transactions,
    messages,
    runService
  );
  const routed = memberMessageRuns.create(principal, {
    roomId: room.roomId,
    content: "Recover this exact Hosted request.",
    mentions: [{
      targetType: "agent",
      targetAgentId: agent.agentId,
      displayLabel: "Central Recovery Agent / Remote model"
    }],
    now
  });
  const run = routed.runs[0];
  assert.ok(run);
  const executor = new InProcessRunExecutor(
    core,
    runs,
    new ContextPlanner(database, core, tasks),
    () => now
  );
  const prepared = executor.prepare(run.runId);
  const execution = hostedAgents.resolveExecutionProfile(agent.agentId);
  let requestSha256: string;
  try {
    requestSha256 = HostedOpenAIResponsesAdapter.prepare({
      profile: {
        model: execution.model,
        maxOutputTokens: execution.executionLimits.maxOutputCharacters
      },
      apiKey: execution.apiKey,
      request: prepared.request,
      fetch: async () => {
        throw new Error("Preparation must not perform HTTPS");
      }
    }).requestSha256;
  } finally {
    execution.apiKey = "";
  }
  const invocations = new HostedInvocationRepository(
    database,
    runs,
    transactions
  );
  invocations.prepare({
    runId: run.runId,
    teamId: created.team.teamId,
    agentId: agent.agentId,
    profileRevision: agent.profileRevision,
    credentialVersion: 1,
    provider: hostedProvider,
    model: "gpt-recovery-test",
    deadlineAt: run.deadlineAt,
    promptSha256: requestSha256,
    now
  });
  return {
    agent,
    configuration,
    core,
    database,
    databasePath,
    invocations,
    principal,
    room,
    run,
    runs
  };
}

function restart(
  databasePath: string,
  clock: () => string,
  fetch: typeof globalThis.fetch,
  options: Omit<HostedRunSchedulerOptions, "fetch"> = {}
) {
  const database = openDatabase(databasePath);
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const runs = new RunRepository(database, transactions);
  const tasks = new AgentTaskRepository(database);
  const hostedAgents = new HostedAgentRepository(
    database,
    { mode: "local_database" },
    transactions
  );
  const invocations = new HostedInvocationRepository(
    database,
    runs,
    transactions
  );
  const scheduler = new HostedRunScheduler(
    core,
    runs,
    hostedAgents,
    invocations,
    new InProcessRunExecutor(
      core,
      runs,
      new ContextPlanner(database, core, tasks),
      clock
    ),
    clock,
    { fetch, ...options }
  );
  return { core, database, invocations, runs, scheduler };
}

async function waitForIdle(scheduler: HostedRunScheduler): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (scheduler.activeCount() === 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Hosted recovery scheduler did not become idle");
}

async function waitForState(
  runs: RunRepository,
  runId: string,
  expected: string
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = runs.getRun(runId);
    if (run?.state === expected) return run;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Hosted recovery Run did not reach ${expected}`);
}

test("prepared Hosted intent runs exactly once after restart", async () => {
  const fixture = await createPreparedFixture("hosted-prepared-recovery-");
  fixture.database.close();
  let providerCalls = 0;
  const restarted = restart(fixture.databasePath, () => later, (async () => {
    providerCalls += 1;
    return providerResponse("Recovered once.");
  }) as typeof fetch);
  try {
    const recovery = restarted.scheduler.recover();
    assert.deepEqual(recovery.runnableRunIds, [fixture.run.runId]);
    await waitForState(restarted.runs, fixture.run.runId, "completed");
    assert.equal(providerCalls, 1);
    assert.equal(
      restarted.invocations.getByRun(fixture.run.runId)?.state,
      "completed"
    );
    assert.equal(
      restarted.core.listMessagesAfter(fixture.room.roomId, 0, 20)
        .some((message) => message.content === "Recovered once."),
      true
    );
  } finally {
    await restarted.scheduler.shutdown();
    restarted.database.close();
  }
});

test("terminal notification retries without replaying Hosted HTTPS", async () => {
  const fixture = await createPreparedFixture("hosted-terminal-notify-retry-");
  fixture.database.close();
  let providerCalls = 0;
  let notificationAttempts = 0;
  const notifiedStates: string[] = [];
  const restarted = restart(
    fixture.databasePath,
    () => later,
    (async () => {
      providerCalls += 1;
      return providerResponse("Notify once, then retry delivery.");
    }) as typeof fetch,
    {
      async onTerminal(run) {
        notificationAttempts += 1;
        notifiedStates.push(run.state);
        if (notificationAttempts === 1) {
          throw new Error("Transient terminal callback failure");
        }
      }
    }
  );
  try {
    restarted.scheduler.recover();
    await waitForState(restarted.runs, fixture.run.runId, "completed");
    await waitForIdle(restarted.scheduler);

    assert.equal(providerCalls, 1);
    assert.equal(notificationAttempts, 2);
    assert.deepEqual(notifiedStates, ["completed", "completed"]);
    assert.equal(
      restarted.invocations.getByRun(fixture.run.runId)?.state,
      "completed"
    );
  } finally {
    await restarted.scheduler.shutdown();
    restarted.database.close();
  }
});

for (const crashedState of ["dispatching", "streaming"] as const) {
  test(`${crashedState} Hosted intent becomes unknown without replay`, async () => {
    const fixture = await createPreparedFixture(`hosted-${crashedState}-recovery-`);
    fixture.invocations.markDispatching(fixture.run.runId, now);
    if (crashedState === "streaming") {
      fixture.invocations.markStreaming(fixture.run.runId, now);
      fixture.runs.applyEvent(fixture.run.runId, {
        type: "status",
        sequence: 2,
        status: "working"
      }, now);
    }
    fixture.core.updateAgentPresence(fixture.agent.agentId, "busy", now);
    fixture.database.close();
    let providerCalls = 0;
    const restarted = restart(fixture.databasePath, () => later, (async () => {
      providerCalls += 1;
      throw new Error("Post-dispatch recovery must not replay HTTPS");
    }) as typeof fetch);
    try {
      const recovery = restarted.scheduler.recover();
      assert.deepEqual(recovery.outcomeUnknownRunIds, [fixture.run.runId]);
      assert.equal(
        restarted.runs.getRun(fixture.run.runId)?.state,
        "outcome_unknown"
      );
      assert.equal(
        restarted.invocations.getByRun(fixture.run.runId)?.state,
        "outcome_unknown"
      );
      assert.equal(
        restarted.core.getAgent(fixture.agent.agentId)?.presence,
        "degraded"
      );
      assert.equal(providerCalls, 0);
    } finally {
      await restarted.scheduler.shutdown();
      restarted.database.close();
    }
  });
}

test("committed reply recovers intent completion without duplicate HTTPS", async () => {
  const fixture = await createPreparedFixture("hosted-terminal-recovery-");
  fixture.invocations.markDispatching(fixture.run.runId, now);
  fixture.invocations.markStreaming(fixture.run.runId, now);
  fixture.runs.applyEvent(fixture.run.runId, {
    type: "status",
    sequence: 2,
    status: "working"
  }, now);
  fixture.runs.applyReplyAndTerminal(
    fixture.run.runId,
    { type: "reply", sequence: 3, content: "Already committed." },
    { type: "status", sequence: 4, status: "completed" },
    now
  );
  fixture.core.updateAgentPresence(fixture.agent.agentId, "busy", now);
  fixture.database.close();
  let providerCalls = 0;
  const restarted = restart(fixture.databasePath, () => later, (async () => {
    providerCalls += 1;
    throw new Error("Committed reply recovery must not replay HTTPS");
  }) as typeof fetch);
  try {
    const recovery = restarted.scheduler.recover();
    assert.deepEqual(recovery.reconciledRunIds, [fixture.run.runId]);
    assert.equal(restarted.runs.getRun(fixture.run.runId)?.state, "completed");
    assert.equal(
      restarted.invocations.getByRun(fixture.run.runId)?.state,
      "completed"
    );
    assert.equal(
      restarted.core.getAgent(fixture.agent.agentId)?.presence,
      "ready"
    );
    assert.equal(providerCalls, 0);
    assert.equal(
      restarted.core.listMessagesAfter(fixture.room.roomId, 0, 20)
        .filter((message) => message.content === "Already committed.").length,
      1
    );
  } finally {
    await restarted.scheduler.shutdown();
    restarted.database.close();
  }
});

test("overdue queued Hosted Run expires before resolving a revoked credential", async () => {
  const fixture = await createPreparedFixture("hosted-overdue-recovery-");
  fixture.configuration.revokeCredential(
    fixture.principal,
    fixture.agent.agentId,
    fixture.agent.profileRevision,
    later
  );
  fixture.database.close();
  let providerCalls = 0;
  const restarted = restart(
    fixture.databasePath,
    () => "2026-08-30T05:21:00.000Z",
    (async () => {
      providerCalls += 1;
      throw new Error("Expired Run must not perform HTTPS");
    }) as typeof fetch
  );
  try {
    restarted.scheduler.recover();
    await waitForState(restarted.runs, fixture.run.runId, "expired");
    assert.equal(providerCalls, 0);
  } finally {
    await restarted.scheduler.shutdown();
    restarted.database.close();
  }
});
