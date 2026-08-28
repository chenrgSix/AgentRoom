import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, device_id TEXT NOT NULL,
      integration_mode TEXT NOT NULL, enabled INTEGER NOT NULL, presence TEXT NOT NULL,
      workspace_ref TEXT NOT NULL, workspace_alias TEXT NOT NULL
    );
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, trace_id TEXT NOT NULL,
      sender_type TEXT NOT NULL, sender_id TEXT NOT NULL
    );
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, room_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL, state TEXT NOT NULL, last_sequence INTEGER NOT NULL,
      trigger_message_id TEXT NOT NULL
    );
    CREATE TABLE run_deliveries (
      run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, device_id TEXT NOT NULL,
      state TEXT NOT NULL, send_count INTEGER NOT NULL, accepted_at TEXT
    );
    CREATE TABLE run_events (
      run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL,
      status TEXT, trace_id TEXT NOT NULL
    );
  `);
  database.prepare("INSERT INTO rooms VALUES (?, ?)").run(ids.roomId, ids.teamId);
  database.prepare("INSERT INTO devices VALUES (?, ?, 'active')")
    .run(ids.deviceId, ids.teamId);
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
  for (const [kind, sendCount] of [["online", 1], ["reconnect", 2]]) {
    const runId = ids[`${kind}RunId`];
    const traceId = ids[`${kind}TraceId`];
    const messageId = `msg_qa002${kind}0001`;
    database.prepare("INSERT INTO messages VALUES (?, ?, ?, 'member', 'member_test0001')")
      .run(messageId, ids.roomId, traceId);
    database.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 'completed', 4, ?)")
      .run(runId, traceId, ids.roomId, ids.agentId, messageId);
    database.prepare("INSERT INTO run_deliveries VALUES (?, ?, ?, 'accepted', ?, ?)")
      .run(runId, traceId, ids.deviceId, sendCount, "2026-08-28T10:01:00.000Z");
    const insertEvent = database.prepare("INSERT INTO run_events VALUES (?, ?, ?, ?, ?)");
    insertEvent.run(runId, 1, "status", "delivered", traceId);
    insertEvent.run(runId, 2, "status", "working", traceId);
    insertEvent.run(runId, 3, "reply", null, traceId);
    insertEvent.run(runId, 4, "status", "completed", traceId);
    database.prepare("INSERT INTO messages VALUES (?, ?, ?, 'agent', ?)")
      .run(`msg_qa002${kind}reply01`, ids.roomId, traceId, ids.agentId);
  }
}

function input(overrides = {}) {
  return {
    schemaVersion: 2,
    utcStart: "2026-08-28T10:00:00.000Z",
    utcEnd: "2026-08-28T10:10:00.000Z",
    serverCommit: "a".repeat(40),
    machineA: "macOS arm64 Central host",
    machineB: "Linux amd64 client host",
    bridgeVersion: "v0.4.0-rc.1",
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
  await writeFile(files.inputPath, JSON.stringify(source));

  const output = await captureEvidence({
    inputPath: files.inputPath,
    databasePath: files.databasePath,
    metricsPath: files.metricsPath,
    outputPath: files.outputPath
  });

  assert.match(output, /`public_ca` \/ public system CA/u);
});

test("the runbook schema-v2 sample stays structurally aligned with the verifier", async () => {
  const runbook = await readFile(new URL(
    "../../docs/acceptance/qa-002-two-machine-managed-agent.md",
    import.meta.url
  ), "utf8");
  const match = runbook.match(/## Machine-readable evidence capture[\s\S]*?```json\n([\s\S]*?)\n```/u);
  assert.ok(match, "runbook must contain the machine-readable JSON sample");
  const documented = JSON.parse(match[1]);
  const expected = input();
  delete expected.secondAgentId;

  assert.equal(documented.schemaVersion, 2);
  assert.deepEqual(Object.keys(documented).sort(), Object.keys(expected).sort());
  assert.deepEqual(
    Object.keys(documented.attestations).sort(),
    Object.keys(expected.attestations).sort()
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
  }), /schemaVersion must be 2/u);

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
