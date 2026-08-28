import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { captureEvidence } from "./capture-two-machine-onboarding-evidence.mjs";

const ids = {
  teamId: "team_qa002test0001",
  roomId: "room_qa002test0001",
  deviceId: "device_qa002test0001",
  agentId: "agent_qa002test0001",
  secondAgentId: "agent_qa002test0002",
  onlineRunId: "run_qa002online0001",
  onlineTraceId: "trace_qa002online0001",
  reconnectRunId: "run_qa002reconnect01",
  reconnectTraceId: "trace_qa002reconnect01"
};

function seed(database) {
  database.exec(`
    CREATE TABLE rooms (room_id TEXT PRIMARY KEY, team_id TEXT NOT NULL);
    CREATE TABLE devices (
      device_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE device_pairing_sessions (
      pairing_session_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
      state TEXT NOT NULL, device_id TEXT, device_platform TEXT,
      bridge_version TEXT, credential_id TEXT, consumed_at TEXT,
      trust_mode TEXT, trust_origin TEXT, trust_installation_id TEXT,
      trust_epoch INTEGER, trust_ca_sha256 TEXT,
      device_supports_scoped_private_trust INTEGER
    );
    CREATE TABLE device_bridge_observations (
      device_id TEXT PRIMARY KEY, connection_epoch INTEGER NOT NULL,
      bridge_version TEXT NOT NULL, observed_at TEXT NOT NULL
    );
    CREATE TABLE device_presence (
      device_id TEXT PRIMARY KEY, connection_epoch INTEGER NOT NULL,
      adapter_available INTEGER NOT NULL, last_heartbeat_at TEXT NOT NULL
    );
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, device_id TEXT NOT NULL,
      integration_mode TEXT NOT NULL, enabled INTEGER NOT NULL, presence TEXT NOT NULL,
      workspace_ref TEXT NOT NULL, workspace_alias TEXT NOT NULL
    );
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, trace_id TEXT NOT NULL,
      sender_type TEXT NOT NULL, sender_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, room_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, state TEXT NOT NULL, last_sequence INTEGER NOT NULL,
      trigger_message_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE run_deliveries (
      run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, device_id TEXT NOT NULL,
      state TEXT NOT NULL, send_count INTEGER NOT NULL, created_at TEXT NOT NULL,
      last_sent_at TEXT, accepted_at TEXT
    );
    CREATE TABLE run_events (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL,
      status TEXT, trace_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO rooms VALUES (?, ?)").run(ids.roomId, ids.teamId);
  database.prepare("INSERT INTO devices VALUES (?, ?, 'active')")
    .run(ids.deviceId, ids.teamId);
  database.prepare(`
    INSERT INTO device_pairing_sessions VALUES (
      'pairing_qa002test0001', ?, 'consumed', ?, 'windows-amd64',
      '0.4.0-rc.1', 'credential_qa002test0001', '2026-08-28T10:00:30.000Z',
      'private_scoped_ca', 'https://qa.example.test',
      'install_qa002test0001', 1, ?, 1
    )
  `).run(ids.teamId, ids.deviceId, "e".repeat(64));
  database.prepare(`
    INSERT INTO device_bridge_observations VALUES (?, 8, '0.4.0-qa030.2', ?)
  `).run(ids.deviceId, "2026-08-28T10:05:00.000Z");
  database.prepare(`
    INSERT INTO device_presence VALUES (?, 8, 1, ?)
  `).run(ids.deviceId, "2026-08-28T10:09:30.000Z");
  const insertAgent = database.prepare(`
    INSERT INTO agents VALUES (?, ?, ?, 'managed', 1, 'ready', ?, ?)
  `);
  insertAgent.run(
    ids.agentId,
    ids.teamId,
    ids.deviceId,
    `workspace_${"c".repeat(64)}`,
    "Acceptance Workspace"
  );
  insertAgent.run(
    ids.secondAgentId,
    ids.teamId,
    ids.deviceId,
    `workspace_${"d".repeat(64)}`,
    "Review Workspace"
  );
  const timelines = {
    online: {
      run: "2026-08-28T10:06:00.000Z",
      sent: "2026-08-28T10:06:01.000Z",
      accepted: "2026-08-28T10:06:02.000Z",
      events: [
        "2026-08-28T10:06:02.000Z",
        "2026-08-28T10:06:03.000Z",
        "2026-08-28T10:06:04.000Z",
        "2026-08-28T10:06:05.000Z"
      ]
    },
    reconnect: {
      run: "2026-08-28T10:04:00.000Z",
      sent: "2026-08-28T10:05:01.000Z",
      accepted: "2026-08-28T10:05:02.000Z",
      events: [
        "2026-08-28T10:05:02.000Z",
        "2026-08-28T10:05:03.000Z",
        "2026-08-28T10:05:04.000Z",
        "2026-08-28T10:05:05.000Z"
      ]
    }
  };
  for (const [kind, sendCount] of [["online", 1], ["reconnect", 2]]) {
    const runId = ids[`${kind}RunId`];
    const traceId = ids[`${kind}TraceId`];
    const messageId = `msg_qa002${kind}0001`;
    const timeline = timelines[kind];
    database.prepare(`
      INSERT INTO messages VALUES (?, ?, ?, 'member', 'member_test0001', ?)
    `).run(messageId, ids.roomId, traceId, timeline.run);
    database.prepare(`
      INSERT INTO runs VALUES (?, ?, ?, ?, 'completed', 4, ?, ?)
    `).run(runId, traceId, ids.roomId, ids.agentId, messageId, timeline.run);
    database.prepare(`
      INSERT INTO run_deliveries VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)
    `).run(
      runId,
      traceId,
      ids.deviceId,
      sendCount,
      timeline.run,
      timeline.sent,
      timeline.accepted
    );
    const insertEvent = database.prepare(`
      INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(runId, 1, "status", "delivered", traceId, timeline.events[0]);
    insertEvent.run(runId, 2, "status", "working", traceId, timeline.events[1]);
    insertEvent.run(runId, 3, "reply", null, traceId, timeline.events[2]);
    insertEvent.run(runId, 4, "status", "completed", traceId, timeline.events[3]);
    database.prepare("INSERT INTO messages VALUES (?, ?, ?, 'agent', ?, ?)")
      .run(
        `msg_qa002${kind}reply01`,
        ids.roomId,
        traceId,
        ids.agentId,
        timeline.events[2]
      );
  }
}

function input(overrides = {}) {
  return {
    schemaVersion: 4,
    utcStart: "2026-08-28T10:00:00.000Z",
    utcEnd: "2026-08-28T10:10:00.000Z",
    metricsCapturedAt: "2026-08-28T10:09:45.000Z",
    serverCommit: "a".repeat(40),
    machineA: "macOS arm64 Central host",
    machineB: "Linux amd64 client host",
    pairingBridgeVersion: "v0.4.0-rc.1",
    bridgeVersion: "v0.4.0-qa030.2",
    bridgeArchiveSha256: "b".repeat(64),
    codexVersion: "codex 1.2.3",
    tlsProfile: "private_scoped_ca",
    httpsVerificationMethod: "Bridge exact-origin private CA",
    ...ids,
    secondAgentId: undefined,
    attestations: {
      twoPhysicalMachines: true,
      bridgeArchiveVerified: true,
      desktopDeepLinkOpened: true,
      verificationPhraseMatched: true,
      runtimeSelfTestCode: "RUNTIME_PROBE_OK",
      runtimeLaunchHadNoUnexpectedConsoleWindow: true,
      bridgeStoppedBeforeReconnectRun: true,
      reconnectRunQueuedBeforeRestart: true,
      sameDeviceReconnected: true,
      installedWithoutManualEnvOrOpenSsl: true,
      noManualCaInstalled: true,
      noApplicationTlsVerificationBypass: true,
      noServerTokenCopied: true,
      noDeviceCredentialCopied: true,
      workspaceProjectionPathFree: true
    },
    review: {
      reviewedAt: "2026-08-28T10:09:50.000Z",
      reviewerRole: "machine-b operator",
      physicalHostsConfirmed: true,
      currentBuildExecutionConfirmed: true,
      evidenceWindowConfirmed: true,
      attestationsConfirmed: true,
      result: "PASS"
    },
    result: "PASS",
    ...overrides
  };
}

const metrics = `agentroom_up 1
agentroom_bridge_connections 1
agentroom_managed_agents 2
agentroom_run_queue_depth 0
agentroom_delivery_pending 0
agentroom_delivery_retries_total 1
agentroom_run_event_lag_seconds 0
agentroom_runs{state="completed"} 2
`;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-qa002-evidence-"));
  const databasePath = path.join(directory, "server.sqlite");
  const database = new Database(databasePath);
  seed(database);
  database.close();
  const inputPath = path.join(directory, "input.json");
  const metricsPath = path.join(directory, "metrics.txt");
  const outputPath = path.join(directory, "evidence.md");
  await writeFile(metricsPath, metrics);
  const metricsCapturedAt = new Date("2026-08-28T10:09:45.000Z");
  await utimes(metricsPath, metricsCapturedAt, metricsCapturedAt);
  return { directory, databasePath, inputPath, metricsPath, outputPath };
}

test("physical evidence capture cross-checks Runs and writes only sanitized facts", async () => {
  const files = await fixture();
  const source = input();
  delete source.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(source));
  const output = await captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  });

  assert.equal(output, await readFile(files.outputPath, "utf8"));
  assert.match(output, /PASS/u);
  assert.match(output, /`private_scoped_ca` \/ Bridge exact-origin private CA/u);
  assert.match(output, /Initial pairing Bridge version: 0\.4\.0-rc\.1/u);
  assert.match(output, /Current Bridge version\/archive SHA-256: 0\.4\.0-qa030\.2/u);
  assert.match(output, /connection epoch 8/u);
  assert.match(output, /## Human review receipt/u);
  assert.match(output, /Reviewer role: machine-b operator/u);
  assert.match(output, /no CA installed into the client OS/u);
  assert.match(output, /no application TLS\s+verification bypass/u);
  assert.match(output, /`queued` → `delivered` → `working` → `completed`/u);
  assert.doesNotMatch(output, new RegExp(files.directory, "u"));
  assert.doesNotMatch(output, /Bearer|private IP|instruction/u);
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /EEXIST|exist/iu);
});

test("physical evidence capture accepts the public system-CA profile", async () => {
  const files = await fixture();
  const source = input({
    tlsProfile: "public_ca",
    httpsVerificationMethod: "public system CA"
  });
  delete source.secondAgentId;
  const database = new Database(files.databasePath);
  database.prepare(`
    UPDATE device_pairing_sessions
    SET trust_mode = NULL, trust_origin = NULL, trust_installation_id = NULL,
        trust_epoch = NULL, trust_ca_sha256 = NULL
  `).run();
  database.close();
  await writeFile(files.inputPath, JSON.stringify(source));

  const output = await captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  });

  assert.match(output, /`public_ca` \/ public system CA/u);
  assert.match(output, /exactly one `consumed` session/u);
});

test("the runbook schema-v4 sample stays structurally aligned with the verifier", async () => {
  const runbook = await readFile(new URL(
    "../../docs/acceptance/qa-002-two-machine-managed-agent.md",
    import.meta.url
  ), "utf8");
  const match = runbook.match(/## Machine-readable evidence capture[\s\S]*?```json\n([\s\S]*?)\n```/u);
  assert.ok(match, "runbook must contain the machine-readable JSON sample");
  const documented = JSON.parse(match[1]);
  const expected = input();
  delete expected.secondAgentId;

  assert.equal(documented.schemaVersion, 4);
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(expected).sort());
  assert.deepEqual(
    Object.keys(documented.attestations).sort(),
    Object.keys(expected.attestations).sort()
  );
  assert.deepEqual(
    Object.keys(documented.review).sort(), Object.keys(expected.review).sort()
  );
});

test("physical evidence capture rejects stale or inconsistent TLS evidence", async () => {
  const files = await fixture();
  const legacy = input({ schemaVersion: 1 });
  delete legacy.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(legacy));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /schemaVersion must be 4/u);

  const manual = input({ tlsProfile: "manual_ca" });
  delete manual.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(manual));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /tlsProfile must be public_ca or private_scoped_ca/u);

  const mismatched = input({ httpsVerificationMethod: "public system CA" });
  delete mismatched.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(mismatched));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /httpsVerificationMethod does not match tlsProfile/u);

  const missing = input();
  delete missing.secondAgentId;
  delete missing.attestations.noManualCaInstalled;
  await writeFile(files.inputPath, JSON.stringify(missing));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /missing=noManualCaInstalled/u);

  for (const attestation of [
    "runtimeLaunchHadNoUnexpectedConsoleWindow",
    "noManualCaInstalled",
    "noApplicationTlsVerificationBypass"
  ]) {
    const unsafe = input({
      attestations: {...input().attestations, [attestation]: false}
    });
    delete unsafe.secondAgentId;
    await writeFile(files.inputPath, JSON.stringify(unsafe));
    await assert.rejects(() => captureEvidence({
      inputPath: files.inputPath,
      databasePath: files.databasePath,
      metricsPath: files.metricsPath,
      outputPath: files.outputPath
    }), new RegExp(`attestation ${attestation} must be true`, "u"));
  }
});

test("physical evidence capture binds TLS claims to one consumed pairing", async () => {
  const files = await fixture();
  const source = input();
  delete source.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(source));
  const capture = () => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  });

  const database = new Database(files.databasePath);
  database.prepare("UPDATE device_pairing_sessions SET bridge_version = '0.4.0-other'").run();
  database.close();
  await assert.rejects(capture, /pairing identity or initial Bridge version does not match/u);

  const versionFixed = new Database(files.databasePath);
  versionFixed.prepare(`
    UPDATE device_pairing_sessions
    SET bridge_version = '0.4.0-rc.1', device_supports_scoped_private_trust = 0
  `).run();
  versionFixed.close();
  await assert.rejects(capture, /does not prove private_scoped_ca capability/u);

  const capabilityFixed = new Database(files.databasePath);
  capabilityFixed.prepare(`
    UPDATE device_pairing_sessions SET device_supports_scoped_private_trust = 1
  `).run();
  capabilityFixed.prepare(`
    INSERT INTO device_pairing_sessions
    SELECT 'pairing_qa002test0002', team_id, state, device_id, device_platform,
           bridge_version, credential_id, consumed_at, trust_mode, trust_origin,
           trust_installation_id, trust_epoch, trust_ca_sha256,
           device_supports_scoped_private_trust
    FROM device_pairing_sessions WHERE pairing_session_id = 'pairing_qa002test0001'
  `).run();
  capabilityFixed.close();
  await assert.rejects(capture, /exactly one consumed pairing session/u);

  const publicClaim = input({
    tlsProfile: "public_ca",
    httpsVerificationMethod: "public system CA"
  });
  delete publicClaim.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(publicClaim));
  const duplicateRemoved = new Database(files.databasePath);
  duplicateRemoved.prepare(`
    DELETE FROM device_pairing_sessions WHERE pairing_session_id = 'pairing_qa002test0002'
  `).run();
  duplicateRemoved.close();
  await assert.rejects(capture, /consumed pairing does not match public_ca/u);
});

test("physical evidence capture binds the package version to authenticated hello state", async () => {
  const files = await fixture();
  const source = input();
  delete source.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(source));
  const database = new Database(files.databasePath);
  database.prepare(`
    UPDATE device_bridge_observations SET bridge_version = '0.4.0-qa030.1'
  `).run();
  database.close();

  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /current authenticated Bridge version observation does not match/u);
});

test("physical evidence capture binds every observation to one bounded time window", async () => {
  const files = await fixture();
  const future = input({
    utcStart: "2026-08-29T10:00:00.000Z",
    utcEnd: "2026-08-29T10:10:00.000Z",
    metricsCapturedAt: "2026-08-29T10:09:45.000Z",
    review: {
      ...input().review,
      reviewedAt: "2026-08-29T10:09:50.000Z"
    }
  });
  delete future.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(future));
  const futureMetricsTime = new Date("2026-08-29T10:09:45.000Z");
  await utimes(files.metricsPath, futureMetricsTime, futureMetricsTime);
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /persisted pairing consumed_at falls outside the evidence window/u);

  const unbounded = input({
    utcStart: "2026-08-27T10:00:00.000Z"
  });
  delete unbounded.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(unbounded));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /evidence window must not exceed 24 hours/u);

  const earlyReview = input({
    review: {
      ...input().review,
      reviewedAt: "2026-08-28T10:09:40.000Z"
    }
  });
  delete earlyReview.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(earlyReview));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /review\.reviewedAt must not precede metricsCapturedAt/u);

  const unreviewed = input({
    review: {
      ...input().review,
      currentBuildExecutionConfirmed: false
    }
  });
  delete unreviewed.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(unreviewed));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /review currentBuildExecutionConfirmed must be true/u);
});

test("physical evidence capture binds metrics to the live observed connection", async () => {
  const files = await fixture();
  const source = input();
  delete source.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(source));
  const capture = () => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  });

  const mismatched = new Database(files.databasePath);
  mismatched.prepare("UPDATE device_presence SET connection_epoch = 7").run();
  mismatched.close();
  await assert.rejects(capture, /presence does not match the authenticated Bridge connection/u);

  const stale = new Database(files.databasePath);
  stale.prepare(`
    UPDATE device_presence
    SET connection_epoch = 8, last_heartbeat_at = '2026-08-28T10:08:00.000Z'
  `).run();
  stale.close();
  await assert.rejects(capture, /current Bridge heartbeat was stale/u);

  const displacedFiles = await fixture();
  await writeFile(displacedFiles.inputPath, JSON.stringify(source));
  const displacedTime = new Date("2026-08-28T10:08:00.000Z");
  await utimes(displacedFiles.metricsPath, displacedTime, displacedTime);
  await assert.rejects(() => captureEvidence({
    inputPath: displacedFiles.inputPath,
    databasePath: displacedFiles.databasePath,
    metricsPath: displacedFiles.metricsPath,
    outputPath: displacedFiles.outputPath
  }), /metricsCapturedAt does not match the metrics snapshot file time/u);
});

test("physical evidence capture proves current-build online and reconnect execution", async () => {
  const onlineFiles = await fixture();
  const source = input();
  delete source.secondAgentId;
  await writeFile(onlineFiles.inputPath, JSON.stringify(source));
  const onlineDatabase = new Database(onlineFiles.databasePath);
  onlineDatabase.prepare(`
    UPDATE messages SET created_at = '2026-08-28T10:04:30.000Z'
    WHERE trace_id = ? AND sender_type = 'member'
  `).run(ids.onlineTraceId);
  onlineDatabase.prepare(`
    UPDATE runs SET created_at = '2026-08-28T10:04:30.000Z' WHERE run_id = ?
  `).run(ids.onlineRunId);
  onlineDatabase.prepare(`
    UPDATE run_deliveries SET created_at = '2026-08-28T10:04:30.000Z'
    WHERE run_id = ?
  `).run(ids.onlineRunId);
  onlineDatabase.close();
  await assert.rejects(() => captureEvidence({
    inputPath: onlineFiles.inputPath,
    databasePath: onlineFiles.databasePath,
    metricsPath: onlineFiles.metricsPath,
    outputPath: onlineFiles.outputPath
  }), /online Run was not created on the current Bridge connection/u);

  const reconnectFiles = await fixture();
  await writeFile(reconnectFiles.inputPath, JSON.stringify(source));
  const reconnectDatabase = new Database(reconnectFiles.databasePath);
  reconnectDatabase.prepare(`
    UPDATE messages SET created_at = '2026-08-28T10:05:30.000Z'
    WHERE trace_id = ? AND sender_type = 'member'
  `).run(ids.reconnectTraceId);
  reconnectDatabase.prepare(`
    UPDATE runs SET created_at = '2026-08-28T10:05:30.000Z' WHERE run_id = ?
  `).run(ids.reconnectRunId);
  reconnectDatabase.prepare(`
    UPDATE run_deliveries SET created_at = '2026-08-28T10:05:30.000Z',
        last_sent_at = '2026-08-28T10:05:31.000Z',
        accepted_at = '2026-08-28T10:05:32.000Z'
    WHERE run_id = ?
  `).run(ids.reconnectRunId);
  reconnectDatabase.close();
  await assert.rejects(() => captureEvidence({
    inputPath: reconnectFiles.inputPath,
    databasePath: reconnectFiles.databasePath,
    metricsPath: reconnectFiles.metricsPath,
    outputPath: reconnectFiles.outputPath
  }), /reconnect Run was not queued before the current Bridge connection/u);

  const acceptedFiles = await fixture();
  await writeFile(acceptedFiles.inputPath, JSON.stringify(source));
  const acceptedDatabase = new Database(acceptedFiles.databasePath);
  acceptedDatabase.prepare(`
    UPDATE run_deliveries
    SET last_sent_at = '2026-08-28T10:04:58.000Z',
        accepted_at = '2026-08-28T10:04:59.000Z'
    WHERE run_id = ?
  `).run(ids.reconnectRunId);
  acceptedDatabase.close();
  await assert.rejects(() => captureEvidence({
    inputPath: acceptedFiles.inputPath,
    databasePath: acceptedFiles.databasePath,
    metricsPath: acceptedFiles.metricsPath,
    outputPath: acceptedFiles.outputPath
  }), /reconnect Delivery was not sent and accepted on the current Bridge connection/u);

  const reorderedFiles = await fixture();
  await writeFile(reorderedFiles.inputPath, JSON.stringify(source));
  const reorderedDatabase = new Database(reorderedFiles.databasePath);
  reorderedDatabase.prepare(`
    UPDATE run_deliveries
    SET last_sent_at = '2026-08-28T10:05:30.000Z'
    WHERE run_id = ?
  `).run(ids.onlineRunId);
  reorderedDatabase.close();
  await assert.rejects(() => captureEvidence({
    inputPath: reorderedFiles.inputPath,
    databasePath: reorderedFiles.databasePath,
    metricsPath: reorderedFiles.metricsPath,
    outputPath: reorderedFiles.outputPath
  }), /online Message, Run and Delivery timestamps are not ordered/u);
});

test("physical evidence capture rejects private host details and false reconnect scope", async () => {
  const files = await fixture();
  const unsafe = input({ machineB: "client at 192.168.1.44" });
  delete unsafe.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(unsafe));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /private or credential-shaped/u);

  const wrong = input({ reconnectRunId: ids.onlineRunId });
  delete wrong.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(wrong));
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /distinct work/u);

  const valid = input();
  delete valid.secondAgentId;
  await writeFile(files.inputPath, JSON.stringify(valid));
  const database = new Database(files.databasePath);
  database.prepare("UPDATE agents SET workspace_ref = ? WHERE agent_id = ?")
    .run("/Users/example/private-workspace", ids.agentId);
  database.close();
  await assert.rejects(() => captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  }), /path-free Workspace projection/u);
});
