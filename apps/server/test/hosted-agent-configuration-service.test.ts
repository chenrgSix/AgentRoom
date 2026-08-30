import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { backupDatabase } from "../src/data/backup.js";
import { openDatabase } from "../src/data/database.js";
import {
  HostedAgentRepository,
  hostedProvider
} from "../src/data/hosted-agent-repository.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import {
  HostedAgentConfigurationService,
  type HostedProviderProbe,
  type HostedProviderProbePolicy,
  type HostedProviderProbeResult
} from "../src/hosted/hosted-agent-configuration-service.js";
import { AgentService } from "../src/registry/agent-service.js";
import { HostedOpenAIResponsesProbe } from
  "../src/runtime/hosted-openai-responses-adapter.js";
import { AuthService, AuthorizationError } from
  "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-30T03:00:00.000Z";

async function fixture(options: {
  probe?: HostedProviderProbe;
  probePolicy?: HostedProviderProbePolicy;
  root?: ConstructorParameters<typeof HostedAgentRepository>[1];
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-config-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const auth = new AuthService(database);
  const repository = new HostedAgentRepository(
    database,
    options.root ?? { mode: "local_database" },
    transactions
  );
  const teamRooms = new TeamRoomService(core, auth, repository);
  const agents = new AgentService(core, auth);
  const created = teamRooms.createTeamForUser({
    userId: "user_hostedowner12345678",
    userDisplayName: "Alice",
    teamName: "Hosted Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-31T03:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teamRooms.createRoom(principal, created.team.teamId, "general", now);
  const calls: Array<{ model: string; apiKey: string }> = [];
  const probe = options.probe ?? {
    async test(input) {
      calls.push({ model: input.model, apiKey: input.apiKey });
      return { status: "ready" as const };
    }
  };
  const service = new HostedAgentConfigurationService(
    repository,
    core,
    agents,
    auth,
    transactions,
    probe,
    undefined,
    options.probePolicy
  );
  return {
    agents,
    auth,
    calls,
    core,
    created,
    database,
    databasePath,
    principal,
    repository,
    room,
    service,
    teamRooms
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function queueHostedRun(
  context: Awaited<ReturnType<typeof fixture>>,
  agentId: string
): void {
  const message = context.core.appendMessage({
    messageId: "msg_hosted_config_queue_00000001",
    roomId: context.room.roomId,
    senderType: "member",
    senderId: context.created.owner.memberId,
    content: "Keep this configuration locked while the Run is queued.",
    mentions: [],
    parentMessageId: null,
    createdAt: now
  });
  context.database.prepare(`
    INSERT INTO runs (
      run_id, room_id, task_id, trigger_message_id, requester_member_id,
      target_agent_id, parent_run_id, instruction, state, deadline_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'queued', ?, ?, ?)
  `).run(
    "run_hosted_config_queue_00000001",
    context.room.roomId,
    message.taskId,
    message.messageId,
    context.created.owner.memberId,
    agentId,
    "Queued configuration fence",
    "2026-08-30T03:10:00.000Z",
    now,
    now
  );
}

function connectionInput(teamId: string, signal?: AbortSignal) {
  return {
    teamId,
    provider: hostedProvider,
    model: "gpt-5.4-mini",
    apiKey: "sk-hosted-configuration-probe-secret",
    now,
    ...(signal ? { signal } : {})
  };
}

test("Hosted Agent configuration is explicit, encrypted, revisioned, and recoverable", async () => {
  const context = await fixture();
  const firstKey = "sk-first-hosted-secret";
  const secondKey = "sk-second-hosted-secret";
  try {
    const created = await context.service.create(context.principal, {
      teamId: context.created.team.teamId,
      name: "Central Writer",
      role: "Remote model",
      provider: hostedProvider,
      model: "gpt-5.4-mini",
      apiKey: firstKey,
      roomIds: [context.room.roomId],
      now
    });
    assert.equal(created.presence, "ready");
    assert.deepEqual(created.roomIds, [context.room.roomId]);
    assert.equal(created.credentialConfigured, true);
    assert.equal(created.credentialRevoked, false);
    assert.equal(created.configurationLocked, false);
    assert.equal(created.hasActiveWork, false);
    assert.equal(created.latestTest?.status, "succeeded");
    assert.equal(JSON.stringify(created).includes(firstKey), false);
    assert.equal(context.repository.resolveExecutionProfile(created.agentId).apiKey, firstKey);

    const keyring = context.database.prepare(`
      SELECT root_mode, local_root_key, kdf_salt FROM hosted_credential_keyrings
    `).get() as {
      root_mode: string;
      local_root_key: Buffer;
      kdf_salt: Buffer;
    };
    assert.equal(keyring.root_mode, "local_database");
    assert.equal(keyring.local_root_key.byteLength, 32);
    assert.equal(keyring.kdf_salt.byteLength, 32);
    const stored = context.database.prepare(`
      SELECT ciphertext, nonce, auth_tag FROM hosted_provider_credentials
      WHERE agent_id = ?
    `).all(created.agentId) as Array<Record<string, Buffer>>;
    assert.equal(stored.length, 1);
    assert.equal(
      stored.some((row) => Object.values(row).some((value) =>
        value.includes(Buffer.from(firstKey, "utf8"))
      )),
      false
    );

    const updated = await context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      apiKey: secondKey,
      now: "2026-08-30T03:01:00.000Z"
    });
    assert.equal(updated.profileRevision, 2);
    assert.equal(updated.model, "gpt-5.4");
    assert.equal(
      context.repository.resolveExecutionProfile(created.agentId).apiKey,
      secondKey
    );
    const versions = context.database.prepare(`
      SELECT credential_version, revoked_at, replaced_by_version
      FROM hosted_provider_credentials WHERE agent_id = ?
      ORDER BY credential_version
    `).all(created.agentId) as Array<{
      credential_version: number;
      revoked_at: string | null;
      replaced_by_version: number | null;
    }>;
    assert.deepEqual(versions.map((row) => ({
      version: row.credential_version,
      revoked: row.revoked_at !== null,
      replacedBy: row.replaced_by_version
    })), [
      { version: 1, revoked: true, replacedBy: 2 },
      { version: 2, revoked: false, replacedBy: null }
    ]);
    assert.equal(context.calls.length, 2);

    const revoked = context.service.revokeCredential(
      context.principal,
      created.agentId,
      2,
      "2026-08-30T03:02:00.000Z"
    );
    assert.equal(revoked.credentialRevoked, true);
    assert.equal(revoked.presence, "degraded");
    assert.throws(
      () => context.repository.resolveExecutionProfile(created.agentId),
      /credential is unavailable/u
    );

    const restored = await context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 2,
      model: "gpt-5.4-mini",
      apiKey: "sk-restored-hosted-secret",
      now: "2026-08-30T03:03:00.000Z"
    });
    assert.equal(restored.profileRevision, 3);
    assert.equal(restored.credentialRevoked, false);
    assert.equal(restored.presence, "ready");
    assert.equal(
      context.repository.resolveExecutionProfile(created.agentId).apiKey,
      "sk-restored-hosted-secret"
    );
    assert.equal(context.calls.length, 3);

    const backupPath = path.join(
      path.dirname(context.databasePath),
      "backups",
      "configured-hosted.sqlite"
    );
    await backupDatabase(context.databasePath, backupPath);
    const backupBytes = await readFile(backupPath);
    for (const plaintext of [
      firstKey,
      secondKey,
      "sk-restored-hosted-secret"
    ]) {
      assert.equal(backupBytes.includes(Buffer.from(plaintext, "utf8")), false);
    }
    const restoredDatabase = openDatabase(backupPath);
    try {
      const restoredRepository = new HostedAgentRepository(
        restoredDatabase,
        { mode: "local_database" }
      );
      assert.equal(
        restoredRepository.resolveExecutionProfile(created.agentId).apiKey,
        "sk-restored-hosted-secret"
      );
    } finally {
      restoredDatabase.close();
    }
  } finally {
    context.database.close();
  }
});

test("stale Hosted profile updates are rejected before provider dispatch", async () => {
  const context = await fixture();
  try {
    const created = await context.service.create(context.principal, {
      ...connectionInput(context.created.team.teamId),
      name: "Revision Fenced",
      role: "Remote model",
      roomIds: [context.room.roomId]
    });
    await context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      now
    });
    assert.equal(context.calls.length, 2);
    await assert.rejects(context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4-mini",
      apiKey: "sk-stale-replacement-secret",
      now
    }), /changed; reload and retry/u);
    assert.equal(context.calls.length, 2);
    assert.equal(context.repository.getCurrentProfile(created.agentId)?.profileRevision, 2);
    assert.equal((context.database.prepare(`
      SELECT count(*) AS count FROM hosted_provider_credentials
    `).get() as { count: number }).count, 1);
  } finally {
    context.database.close();
  }
});

test("queued work locks configuration and is rechecked after the provider probe", async () => {
  const updateStarted = deferred<void>();
  const completeUpdateProbe = deferred<HostedProviderProbeResult>();
  let probeCalls = 0;
  const context = await fixture({
    probe: {
      async test() {
        probeCalls += 1;
        if (probeCalls === 1) return { status: "ready" };
        updateStarted.resolve();
        return completeUpdateProbe.promise;
      }
    }
  });
  try {
    const created = await context.service.create(context.principal, {
      ...connectionInput(context.created.team.teamId),
      name: "Queued Fenced",
      role: "Remote model",
      roomIds: [context.room.roomId]
    });
    const pendingUpdate = context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      apiKey: "sk-racing-replacement-secret",
      now
    });
    await updateStarted.promise;
    queueHostedRun(context, created.agentId);
    const queued = context.service.list(
      context.principal,
      context.created.team.teamId
    )[0]!;
    assert.equal(queued.presence, "ready");
    assert.equal(queued.configurationLocked, true);
    assert.equal(queued.hasActiveWork, true);
    completeUpdateProbe.resolve({ status: "ready" });
    await assert.rejects(pendingUpdate, /locked while work is active/u);
    assert.equal(context.repository.getCurrentProfile(created.agentId)?.profileRevision, 1);
    assert.equal((context.database.prepare(`
      SELECT count(*) AS count FROM hosted_provider_credentials
    `).get() as { count: number }).count, 1);
    await assert.rejects(context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      now
    }), /locked while work is active/u);
    assert.equal(probeCalls, 2);
  } finally {
    context.service.shutdown();
    context.database.close();
  }
});

test("credential revocation fences an in-flight profile replacement", async () => {
  const updateStarted = deferred<void>();
  const completeUpdateProbe = deferred<HostedProviderProbeResult>();
  let probeCalls = 0;
  const context = await fixture({
    probe: {
      async test() {
        probeCalls += 1;
        if (probeCalls === 1) return { status: "ready" };
        updateStarted.resolve();
        return completeUpdateProbe.promise;
      }
    }
  });
  try {
    const created = await context.service.create(context.principal, {
      ...connectionInput(context.created.team.teamId),
      name: "Revocation Fenced",
      role: "Remote model",
      roomIds: [context.room.roomId]
    });
    const pendingUpdate = context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      apiKey: "sk-racing-replacement-secret",
      now
    });
    await updateStarted.promise;
    context.service.revokeCredential(context.principal, created.agentId, 1, now);
    completeUpdateProbe.resolve({ status: "ready" });
    await assert.rejects(pendingUpdate, /changed; reload and retry/u);
    const configuration = context.service.list(
      context.principal,
      context.created.team.teamId
    )[0]!;
    assert.equal(configuration.profileRevision, 1);
    assert.equal(configuration.credentialRevoked, true);
    assert.equal((context.database.prepare(`
      SELECT count(*) AS count FROM hosted_provider_credentials
    `).get() as { count: number }).count, 1);
  } finally {
    context.service.shutdown();
    context.database.close();
  }
});

for (const change of ["busy", "revised"] as const) {
  test(`a configured probe cannot overwrite ${change} Agent state`, async () => {
    const probeStarted = deferred<void>();
    const completeProbe = deferred<HostedProviderProbeResult>();
    let probeCalls = 0;
    const context = await fixture({
      probe: {
        async test() {
          probeCalls += 1;
          if (probeCalls === 1) return { status: "ready" };
          probeStarted.resolve();
          return completeProbe.promise;
        }
      }
    });
    try {
      const created = await context.service.create(context.principal, {
        ...connectionInput(context.created.team.teamId),
        name: "Observation Fenced",
        role: "Remote model",
        roomIds: [context.room.roomId]
      });
      const pending = context.service.testConfigured(
        context.principal,
        created.agentId,
        now
      );
      await probeStarted.promise;
      if (change === "revised") {
        context.repository.createProfile({
          agentId: created.agentId,
          teamId: created.teamId,
          provider: hostedProvider,
          model: "gpt-5.4",
          credentialVersion: 1,
          createdByMemberId: context.created.owner.memberId,
          expectedRevision: 1,
          now
        });
      }
      context.core.updateAgentPresence(
        created.agentId,
        change === "busy" ? "busy" : "degraded",
        now
      );
      completeProbe.resolve({ status: "ready" });
      const observation = await pending;
      assert.equal(observation.profileRevision, 1);
      assert.equal(observation.status, "succeeded");
      assert.equal(
        context.core.getAgent(created.agentId)?.presence,
        change === "busy" ? "busy" : "degraded"
      );
    } finally {
      context.service.shutdown();
      context.database.close();
    }
  });
}

test("a stalled provider fetch is aborted at the configuration probe deadline", {
  timeout: 2_000
}, async () => {
  let transportSignal: AbortSignal | undefined;
  const started = deferred<void>();
  const stalledFetch: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal);
    transportSignal = init.signal;
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init.signal!.aborted) rejectAbort();
      else init.signal!.addEventListener("abort", rejectAbort, { once: true });
    });
  };
  const context = await fixture({
    probe: new HostedOpenAIResponsesProbe(stalledFetch),
    probePolicy: { deadlineMilliseconds: 50, maximumConcurrency: 2 }
  });
  try {
    const pending = context.service.testConnection(
      context.principal,
      connectionInput(context.created.team.teamId)
    );
    await started.promise;
    const observation = await pending;
    assert.equal(observation.status, "failed");
    assert.equal(observation.failureCode, "HOSTED_PROVIDER_PROBE_TIMEOUT");
    assert.equal(transportSignal?.aborted, true);
  } finally {
    context.service.shutdown();
    context.database.close();
  }
});

test("all Hosted configuration operations share the same probe concurrency limit", {
  timeout: 5_000
}, async () => {
  let holdProbes = false;
  let activeProbes = 0;
  let peakProbes = 0;
  const probes: Array<ReturnType<typeof deferred<HostedProviderProbeResult>>> = [];
  const secondStarted = deferred<void>();
  const thirdStarted = deferred<void>();
  const fourthStarted = deferred<void>();
  const context = await fixture({
    probe: {
      async test() {
        if (!holdProbes) return { status: "ready" };
        activeProbes += 1;
        peakProbes = Math.max(peakProbes, activeProbes);
        const pending = deferred<HostedProviderProbeResult>();
        probes.push(pending);
        if (probes.length === 2) secondStarted.resolve();
        if (probes.length === 3) thirdStarted.resolve();
        if (probes.length === 4) fourthStarted.resolve();
        try {
          return await pending.promise;
        } finally {
          activeProbes -= 1;
        }
      }
    },
    probePolicy: { deadlineMilliseconds: 1_000, maximumConcurrency: 2 }
  });
  const pending: Array<Promise<unknown>> = [];
  try {
    const created = await context.service.create(context.principal, {
      ...connectionInput(context.created.team.teamId),
      name: "Shared Limit",
      role: "Remote model",
      roomIds: [context.room.roomId]
    });
    holdProbes = true;
    pending.push(
      context.service.testConnection(
        context.principal,
        connectionInput(context.created.team.teamId)
      ),
      context.service.testConfigured(context.principal, created.agentId, now),
      context.service.updateProfile(context.principal, {
        agentId: created.agentId,
        expectedProfileRevision: 1,
        model: "gpt-5.4",
        now
      }),
      context.service.create(context.principal, {
        ...connectionInput(context.created.team.teamId),
        name: "Queued Creation",
        role: "Remote model",
        roomIds: [context.room.roomId]
      })
    );
    await secondStarted.promise;
    assert.equal(probes.length, 2);
    assert.equal(activeProbes, 2);
    probes[0]!.resolve({ status: "ready" });
    await thirdStarted.promise;
    assert.equal(probes.length, 3);
    probes[1]!.resolve({ status: "ready" });
    await fourthStarted.promise;
    probes[2]!.resolve({ status: "ready" });
    probes[3]!.resolve({ status: "ready" });
    await Promise.all(pending);
    assert.equal(peakProbes, 2);
    assert.equal(activeProbes, 0);
  } finally {
    context.service.shutdown();
    for (const probe of probes) probe.resolve({ status: "failed" });
    await Promise.allSettled(pending);
    context.database.close();
  }
});

test("probes that ignore abort retain their slots while queued callers time out", {
  timeout: 2_000
}, async () => {
  const probes: Array<ReturnType<typeof deferred<HostedProviderProbeResult>>> = [];
  const signals: AbortSignal[] = [];
  const context = await fixture({
    probe: {
      async test(input) {
        assert.ok(input.signal);
        signals.push(input.signal);
        const pending = deferred<HostedProviderProbeResult>();
        probes.push(pending);
        return pending.promise;
      }
    },
    probePolicy: { deadlineMilliseconds: 40, maximumConcurrency: 2 }
  });
  try {
    for (let wave = 0; wave < 2; wave += 1) {
      const observations = await Promise.all(Array.from({ length: 4 }, () =>
        context.service.testConnection(
          context.principal,
          connectionInput(context.created.team.teamId)
        )
      ));
      assert.ok(observations.every((observation) =>
        observation.status === "failed" &&
        observation.failureCode === "HOSTED_PROVIDER_PROBE_TIMEOUT"
      ));
      assert.equal(probes.length, 2);
      assert.ok(signals.every((signal) => signal.aborted));
    }
  } finally {
    context.service.shutdown();
    for (const probe of probes) probe.resolve({ status: "failed" });
    context.database.close();
  }
});

test("caller cancellation and service shutdown abort probes and queued work", {
  timeout: 2_000
}, async () => {
  const signals: AbortSignal[] = [];
  const started: Array<ReturnType<typeof deferred<void>>> = [deferred(), deferred()];
  const context = await fixture({
    probe: {
      async test(input) {
        assert.ok(input.signal);
        signals.push(input.signal);
        started[signals.length - 1]!.resolve();
        return new Promise<HostedProviderProbeResult>((_resolve, reject) => {
          input.signal!.addEventListener("abort", () => reject(
            new DOMException("Aborted", "AbortError")
          ), { once: true });
        });
      }
    },
    probePolicy: { deadlineMilliseconds: 1_000, maximumConcurrency: 1 }
  });
  try {
    const caller = new AbortController();
    const canceledByCaller = context.service.testConnection(
      context.principal,
      connectionInput(context.created.team.teamId, caller.signal)
    );
    await started[0]!.promise;
    caller.abort();
    assert.equal(
      (await canceledByCaller).failureCode,
      "HOSTED_PROVIDER_PROBE_CANCELED"
    );
    assert.equal(signals[0]!.aborted, true);

    const pending = context.service.testConnection(
      context.principal,
      connectionInput(context.created.team.teamId)
    );
    const queued = context.service.testConnection(
      context.principal,
      connectionInput(context.created.team.teamId)
    );
    await started[1]!.promise;
    context.service.shutdown();
    const observations = await Promise.all([pending, queued]);
    assert.ok(observations.every((observation) =>
      observation.failureCode === "HOSTED_PROVIDER_PROBE_CANCELED"
    ));
    assert.equal(signals.length, 2);
    assert.equal(signals[1]!.aborted, true);
    assert.equal((await context.service.testConnection(
      context.principal,
      connectionInput(context.created.team.teamId)
    )).failureCode, "HOSTED_PROVIDER_PROBE_CANCELED");
    assert.equal(signals.length, 2);
  } finally {
    context.service.shutdown();
    context.database.close();
  }
});

test("Hosted Presence follows active Room membership and lifecycle", async () => {
  const context = await fixture();
  try {
    const created = await context.service.create(context.principal, {
      teamId: context.created.team.teamId,
      name: "Central Room Agent",
      role: "Remote model",
      provider: hostedProvider,
      model: "gpt-5.4-mini",
      apiKey: "sk-room-presence-secret",
      roomIds: [context.room.roomId],
      now
    });
    assert.equal(created.presence, "ready");

    context.teamRooms.replaceRoomParticipants(context.principal, context.room.roomId, {
      memberIds: [context.created.owner.memberId],
      agentIds: []
    }, "2026-08-30T03:01:00.000Z");
    assert.equal(context.repository.getAvailability(created.agentId), "degraded");
    assert.equal(context.core.getAgent(created.agentId)?.presence, "degraded");

    context.teamRooms.replaceRoomParticipants(context.principal, context.room.roomId, {
      memberIds: [context.created.owner.memberId],
      agentIds: [created.agentId]
    }, "2026-08-30T03:02:00.000Z");
    assert.equal(context.repository.getAvailability(created.agentId), "ready");
    assert.equal(context.core.getAgent(created.agentId)?.presence, "ready");

    context.teamRooms.updateRoom(context.principal, context.room.roomId, {
      archived: true
    }, "2026-08-30T03:03:00.000Z");
    assert.equal(context.repository.getAvailability(created.agentId), "degraded");
    assert.equal(context.core.getAgent(created.agentId)?.presence, "degraded");

    context.teamRooms.updateRoom(context.principal, context.room.roomId, {
      archived: false
    }, "2026-08-30T03:04:00.000Z");
    assert.equal(context.repository.getAvailability(created.agentId), "ready");
    assert.equal(context.core.getAgent(created.agentId)?.presence, "ready");
  } finally {
    context.database.close();
  }
});

test("Hosted configuration fails closed before persistence and enforces Owner scope", async () => {
  const context = await fixture({
    probe: {
      async test() {
        return {
          status: "failed",
          failureCode: "HOSTED_PROVIDER_AUTH_REJECTED"
        };
      }
    }
  });
  try {
    await assert.rejects(
      context.service.create(context.principal, {
        teamId: context.created.team.teamId,
        name: "Rejected",
        role: "Remote model",
        provider: hostedProvider,
        model: "gpt-5.4-mini",
        apiKey: "sk-rejected-secret",
        roomIds: [context.room.roomId],
        now
      }),
      /connection test failed/u
    );
    assert.equal(
      (context.database.prepare(`SELECT count(*) AS count FROM agents`)
        .get() as { count: number }).count,
      0
    );

    const memberUserId = "user_hostedmember1234567";
    context.core.createUser({
      userId: memberUserId,
      displayName: "Bob",
      createdAt: now
    });
    context.core.createMember({
      memberId: "member_hostedmember12345",
      teamId: context.created.team.teamId,
      userId: memberUserId,
      displayName: "Bob",
      role: "member",
      createdAt: now
    });
    const memberSession = context.auth.issueWebSession(
      memberUserId,
      now,
      "2026-08-31T03:00:00.000Z"
    );
    const memberPrincipal = context.auth.authenticateWebSession(
      memberSession.secret,
      now
    );
    await assert.rejects(
      context.service.testConnection(memberPrincipal, {
        teamId: context.created.team.teamId,
        provider: hostedProvider,
        model: "gpt-5.4-mini",
        apiKey: "sk-member-secret",
        now
      }),
      (error: unknown) => error instanceof AuthorizationError &&
        error.code === "FORBIDDEN"
    );
  } finally {
    context.database.close();
  }
});

test("trusted Hosted credential envelopes require the original recovery authority", async () => {
  const root = {
    mode: "trusted_recovery" as const,
    secret: "owner-recovery-token-0123456789abcdef"
  };
  const context = await fixture({ root });
  try {
    const created = await context.service.create(context.principal, {
      teamId: context.created.team.teamId,
      name: "Trusted Hosted",
      role: "Remote model",
      provider: hostedProvider,
      model: "gpt-5.4-mini",
      apiKey: "sk-trusted-secret",
      roomIds: [context.room.roomId],
      now
    });
    const keyring = context.database.prepare(`
      SELECT root_mode, local_root_key FROM hosted_credential_keyrings
    `).get() as { root_mode: string; local_root_key: Buffer | null };
    assert.equal(keyring.root_mode, "trusted_recovery");
    assert.equal(keyring.local_root_key, null);
    const wrong = new HostedAgentRepository(context.database, {
      mode: "trusted_recovery",
      secret: "wrong-recovery-token-abcdef0123456789"
    });
    assert.throws(
      () => wrong.resolveExecutionProfile(created.agentId),
      /could not be decrypted/u
    );
  } finally {
    context.database.close();
  }
});
