import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

const inputKeys = new Set([
  "schemaVersion",
  "utcStart",
  "utcEnd",
  "serverCommit",
  "machineA",
  "machineB",
  "pairingBridgeVersion",
  "bridgeVersion",
  "bridgeArchiveSha256",
  "codexVersion",
  "tlsProfile",
  "httpsVerificationMethod",
  "teamId",
  "roomId",
  "deviceId",
  "agentId",
  "onlineRunId",
  "onlineTraceId",
  "reconnectRunId",
  "reconnectTraceId",
  "attestations",
  "result"
]);

const attestationKeys = new Set([
  "twoPhysicalMachines",
  "bridgeArchiveVerified",
  "desktopDeepLinkOpened",
  "verificationPhraseMatched",
  "runtimeSelfTestCode",
  "bridgeStoppedBeforeReconnectRun",
  "reconnectRunQueuedBeforeRestart",
  "sameDeviceReconnected",
  "installedWithoutManualEnvOrOpenSsl",
  "noManualCaInstalled",
  "noApplicationTlsVerificationBypass",
  "noServerTokenCopied",
  "noDeviceCredentialCopied",
  "workspaceProjectionPathFree"
]);

const forbiddenEvidence = [
  /\bBearer\b/iu,
  /\b(?:password|secret|token)\s*[:=]/iu,
  /-----BEGIN [^-]*PRIVATE KEY-----/u,
  /(?:^|\s)\/(?:Users|home)\//u,
  /[A-Za-z]:\\/u,
  /\b10(?:\.\d{1,3}){3}\b/u,
  /\b192\.168(?:\.\d{1,3}){2}\b/u,
  /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/u
];

function fail(message) {
  throw new Error(`QA-002 evidence invalid: ${message}`);
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !keys.includes(key));
  if (unknown.length || missing.length) {
    fail(`${label} keys differ (unknown=${unknown.join(",")}; missing=${missing.join(",")})`);
  }
}

function safeText(value, label, maximum = 180) {
  if (typeof value !== "string" || value.trim() !== value ||
      value.length < 1 || value.length > maximum || value.includes("\n")) {
    fail(`${label} must be one bounded line`);
  }
  if (forbiddenEvidence.some((pattern) => pattern.test(value))) {
    fail(`${label} contains private or credential-shaped material`);
  }
  return value;
}

function opaqueId(value, prefix, label) {
  const normalized = safeText(value, label, 140);
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,128}$`, "u").test(normalized)) {
    fail(`${label} is not a ${prefix} identity`);
  }
  return normalized;
}

function timestamp(value, label) {
  const normalized = safeText(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(normalized) ||
      Number.isNaN(Date.parse(normalized))) {
    fail(`${label} must be a UTC RFC3339 timestamp`);
  }
  return normalized;
}

function normalizedBridgeVersion(value, label) {
  const normalized = safeText(value, label, 80).replace(/^v/u, "");
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(normalized)) {
    fail(`${label} must be a semantic version`);
  }
  return normalized;
}

function canonicalPersistedBridgeVersion(value, label) {
  const normalized = normalizedBridgeVersion(value, label);
  if (value !== normalized) fail(`${label} must be canonical`);
  return normalized;
}

function validateInput(input) {
  exactKeys(input, inputKeys, "input");
  exactKeys(input.attestations, attestationKeys, "attestations");
  if (input.schemaVersion !== 3) fail("schemaVersion must be 3");
  const utcStart = timestamp(input.utcStart, "utcStart");
  const utcEnd = timestamp(input.utcEnd, "utcEnd");
  if (Date.parse(utcStart) >= Date.parse(utcEnd)) fail("utcEnd must follow utcStart");
  if (!/^[0-9a-f]{40}$/u.test(input.serverCommit)) {
    fail("serverCommit must be one exact 40-character commit");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.bridgeArchiveSha256)) {
    fail("bridgeArchiveSha256 must be one SHA-256 digest");
  }
  for (const field of [
    "machineA", "machineB", "codexVersion",
    "httpsVerificationMethod"
  ]) safeText(input[field], field);
  normalizedBridgeVersion(input.pairingBridgeVersion, "pairingBridgeVersion");
  normalizedBridgeVersion(input.bridgeVersion, "bridgeVersion");
  const verificationMethods = {
    public_ca: "public system CA",
    private_scoped_ca: "Bridge exact-origin private CA"
  };
  if (!Object.hasOwn(verificationMethods, input.tlsProfile)) {
    fail("tlsProfile must be public_ca or private_scoped_ca");
  }
  if (input.httpsVerificationMethod !== verificationMethods[input.tlsProfile]) {
    fail("httpsVerificationMethod does not match tlsProfile");
  }
  if (input.machineA === input.machineB) fail("machine descriptions must be distinct");
  opaqueId(input.teamId, "team", "teamId");
  opaqueId(input.roomId, "room", "roomId");
  opaqueId(input.deviceId, "device", "deviceId");
  opaqueId(input.agentId, "agent", "agentId");
  opaqueId(input.onlineRunId, "run", "onlineRunId");
  opaqueId(input.onlineTraceId, "trace", "onlineTraceId");
  opaqueId(input.reconnectRunId, "run", "reconnectRunId");
  opaqueId(input.reconnectTraceId, "trace", "reconnectTraceId");
  if (input.onlineRunId === input.reconnectRunId ||
      input.onlineTraceId === input.reconnectTraceId) {
    fail("online and reconnect evidence must identify distinct work");
  }
  for (const [key, value] of Object.entries(input.attestations)) {
    if (key === "runtimeSelfTestCode") {
      if (value !== "RUNTIME_PROBE_OK") fail("Runtime self-test did not pass");
    } else if (value !== true) {
      fail(`attestation ${key} must be true`);
    }
  }
  if (input.result !== "PASS") fail("result must be PASS");
  return input;
}

function parseMetrics(source) {
  const metrics = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^([a-z_]+(?:\{state="[a-z_]+"\})?)\s+([0-9]+(?:\.[0-9]+)?)$/u);
    if (match) metrics.set(match[1], Number(match[2]));
  }
  const required = [
    "agentroom_up",
    "agentroom_bridge_connections",
    "agentroom_managed_agents",
    "agentroom_run_queue_depth",
    "agentroom_delivery_pending",
    "agentroom_delivery_retries_total",
    "agentroom_run_event_lag_seconds",
    'agentroom_runs{state="completed"}'
  ];
  for (const name of required) {
    if (!Number.isFinite(metrics.get(name))) fail(`metrics omitted ${name}`);
  }
  if (metrics.get("agentroom_up") !== 1) fail("Server was not ready");
  if (metrics.get("agentroom_bridge_connections") < 1) {
    fail("no authenticated Bridge was connected at capture time");
  }
  if (metrics.get("agentroom_managed_agents") < 2) {
    fail("fewer than two managed Agents were enabled at capture time");
  }
  if (metrics.get("agentroom_run_queue_depth") !== 0 ||
      metrics.get("agentroom_delivery_pending") !== 0) {
    fail("acceptance work was still pending at capture time");
  }
  if (metrics.get('agentroom_runs{state="completed"}') < 2) {
    fail("metrics did not contain both completed Runs");
  }
  return Object.fromEntries(required.map((name) => [name, metrics.get(name)]));
}

function assertDatabaseScope(database, input) {
  const room = database.prepare(`
    SELECT team_id FROM rooms WHERE room_id = ?
  `).get(input.roomId);
  if (!room || room.team_id !== input.teamId) fail("Room does not belong to Team");
  const device = database.prepare(`
    SELECT team_id, status FROM devices WHERE device_id = ?
  `).get(input.deviceId);
  if (!device || device.team_id !== input.teamId || device.status !== "active") {
    fail("Device is not active in Team");
  }
  const devices = database.prepare(`
    SELECT count(*) AS count FROM devices WHERE team_id = ?
  `).get(input.teamId);
  if (devices.count !== 1) fail("acceptance Team must contain exactly one Device");
  const pairings = database.prepare(`
    SELECT bridge_version, device_platform, credential_id, consumed_at,
           trust_mode, trust_origin, trust_installation_id, trust_epoch,
           trust_ca_sha256, device_supports_scoped_private_trust
    FROM device_pairing_sessions
    WHERE team_id = ? AND device_id = ? AND state = 'consumed'
  `).all(input.teamId, input.deviceId);
  if (pairings.length !== 1) {
    fail("Device must have exactly one consumed pairing session");
  }
  const pairing = pairings[0];
  if (
    canonicalPersistedBridgeVersion(
      pairing.bridge_version,
      "persisted pairing Bridge version"
    ) !==
      normalizedBridgeVersion(input.pairingBridgeVersion, "pairingBridgeVersion") ||
    typeof pairing.device_platform !== "string" || !pairing.device_platform ||
    typeof pairing.credential_id !== "string" || !pairing.credential_id ||
    typeof pairing.consumed_at !== "string" || !pairing.consumed_at
  ) {
    fail("consumed pairing identity or initial Bridge version does not match");
  }
  const trustFields = [
    pairing.trust_mode,
    pairing.trust_origin,
    pairing.trust_installation_id,
    pairing.trust_epoch,
    pairing.trust_ca_sha256
  ];
  if (input.tlsProfile === "public_ca") {
    if (!trustFields.every((value) => value === null)) {
      fail("consumed pairing does not match public_ca");
    }
  } else if (
    pairing.trust_mode !== "private_scoped_ca" ||
    typeof pairing.trust_origin !== "string" ||
    !pairing.trust_origin.startsWith("https://") ||
    typeof pairing.trust_installation_id !== "string" ||
    !/^install_[A-Za-z0-9_-]{8,128}$/u.test(pairing.trust_installation_id) ||
    !Number.isInteger(pairing.trust_epoch) || pairing.trust_epoch < 1 ||
    typeof pairing.trust_ca_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(pairing.trust_ca_sha256) ||
    pairing.device_supports_scoped_private_trust !== 1
  ) {
    fail("consumed pairing does not prove private_scoped_ca capability");
  }
  const observation = database.prepare(`
    SELECT connection_epoch, bridge_version, observed_at
    FROM device_bridge_observations WHERE device_id = ?
  `).get(input.deviceId);
  if (
    !observation ||
    !Number.isInteger(observation.connection_epoch) ||
    observation.connection_epoch < 1 ||
    canonicalPersistedBridgeVersion(
      observation.bridge_version,
      "persisted current Bridge version"
    ) !== normalizedBridgeVersion(input.bridgeVersion, "bridgeVersion") ||
    typeof observation.observed_at !== "string" ||
    !observation.observed_at
  ) {
    fail("current authenticated Bridge version observation does not match");
  }
  const agents = database.prepare(`
    SELECT count(*) AS count
    FROM agents
    WHERE team_id = ? AND device_id = ? AND integration_mode = 'managed'
      AND enabled = 1
  `).get(input.teamId, input.deviceId);
  if (agents.count < 2) fail("paired Device must publish at least two managed Agents");
  const target = database.prepare(`
    SELECT team_id, device_id, integration_mode, enabled, presence,
           workspace_ref, workspace_alias
    FROM agents WHERE agent_id = ?
  `).get(input.agentId);
  if (!target || target.team_id !== input.teamId ||
      target.device_id !== input.deviceId || target.integration_mode !== "managed" ||
      target.enabled !== 1 || target.presence !== "ready") {
    fail("target Agent is not an enabled managed Agent of the Device");
  }
  if (!/^workspace_[0-9a-f]{64}$/u.test(target.workspace_ref ?? "") ||
      typeof target.workspace_alias !== "string" ||
      target.workspace_alias.length < 1 || target.workspace_alias.length > 80 ||
      /[\\/]/u.test(target.workspace_alias)) {
    fail("target Agent does not have a path-free Workspace projection");
  }
  return {
    state: "consumed",
    tlsProfile: input.tlsProfile,
    pairingBridgeVersion: normalizedBridgeVersion(
      input.pairingBridgeVersion,
      "pairingBridgeVersion"
    ),
    currentBridgeVersion: normalizedBridgeVersion(
      input.bridgeVersion,
      "bridgeVersion"
    )
  };
}

function inspectRun(database, input, kind) {
  const runId = input[`${kind}RunId`];
  const traceId = input[`${kind}TraceId`];
  const row = database.prepare(`
    SELECT r.run_id, r.trace_id, r.room_id, r.target_agent_id, r.state,
           r.last_sequence, r.trigger_message_id,
           m.trace_id AS message_trace_id,
           d.trace_id AS delivery_trace_id, d.device_id, d.state AS delivery_state,
           d.send_count, d.accepted_at
    FROM runs r
    JOIN messages m ON m.message_id = r.trigger_message_id
    JOIN run_deliveries d ON d.run_id = r.run_id
    WHERE r.run_id = ?
  `).get(runId);
  if (!row || row.trace_id !== traceId || row.message_trace_id !== traceId ||
      row.delivery_trace_id !== traceId || row.room_id !== input.roomId ||
      row.target_agent_id !== input.agentId || row.device_id !== input.deviceId) {
    fail(`${kind} Run trace or ownership chain does not match`);
  }
  if (row.state !== "completed" || row.delivery_state !== "accepted" ||
      row.send_count < 1 || !row.accepted_at) {
    fail(`${kind} Run did not reach accepted completed state`);
  }
  const events = database.prepare(`
    SELECT sequence, event_type, status, trace_id
    FROM run_events WHERE run_id = ? ORDER BY sequence
  `).all(runId);
  if (events.length !== row.last_sequence || events.some(
    (event, index) => event.sequence !== index + 1 || event.trace_id !== traceId
  )) fail(`${kind} Run event sequence is not contiguous under one trace`);
  const statuses = events.filter((event) => event.event_type === "status")
    .map((event) => event.status);
  for (const required of ["delivered", "working", "completed"]) {
    if (!statuses.includes(required)) fail(`${kind} Run omitted ${required}`);
  }
  if (statuses.at(-1) !== "completed") fail(`${kind} Run terminal event is not completed`);
  if (events.filter((event) => event.event_type === "reply").length !== 1) {
    fail(`${kind} Run did not persist exactly one reply event`);
  }
  const replies = database.prepare(`
    SELECT count(*) AS count FROM messages
    WHERE room_id = ? AND trace_id = ? AND sender_type = 'agent'
      AND sender_id = ?
  `).get(input.roomId, traceId, input.agentId);
  if (replies.count !== 1) fail(`${kind} Run did not project exactly one Agent reply`);
  return {
    runId,
    traceId,
    states: ["queued", ...statuses],
    deliverySendCount: row.send_count,
    replyCount: replies.count
  };
}

function render(input, metrics, pairing, online, reconnect) {
  const metricLines = Object.entries(metrics).map(([name, value]) =>
    `- \`${name}\`: ${value}`
  ).join("\n");
  return `# QA-002 Two-Machine Managed Agent PASS Evidence

Generated by the repository verifier. Human review must still confirm that the
two sanitized host descriptions identify different physical machines.

- UTC start/end: ${input.utcStart} / ${input.utcEnd}
- Server commit: \`${input.serverCommit}\`
- Machine A: ${input.machineA}
- Machine B: ${input.machineB}
- Initial pairing Bridge version: ${pairing.pairingBridgeVersion}
- Current Bridge version/archive SHA-256: ${pairing.currentBridgeVersion} / \`${input.bridgeArchiveSha256}\`
- Codex version: ${input.codexVersion}
- TLS profile/HTTPS verification: \`${input.tlsProfile}\` / ${input.httpsVerificationMethod}
- Team/Room: \`${input.teamId}\` / \`${input.roomId}\`
- Device/Agent: \`${input.deviceId}\` / \`${input.agentId}\`
- Runtime self-test: \`RUNTIME_PROBE_OK\`
- Pairing: installed desktop deep link; matching phrase; no copied Server Token
  or Device credential; no CA installed into the client OS; no application TLS
  verification bypass
- Database pairing proof: exactly one \`${pairing.state}\` session; Device,
  Team, initial Bridge version and \`${pairing.tlsProfile}\` profile matched
- Authenticated hello proof: current Bridge version matched without replacing the
  Device or its original pairing identity
- Workspace projection: path-free
- Online Run/trace: \`${online.runId}\` / \`${online.traceId}\`
- Online persisted states: ${online.states.map((state) => `\`${state}\``).join(" → ")}
- Online reply count: ${online.replyCount}
- Reconnect Run/trace: \`${reconnect.runId}\` / \`${reconnect.traceId}\`
- Reconnect persisted states: ${reconnect.states.map((state) => `\`${state}\``).join(" → ")}
- Reconnect observation: queued while Bridge stopped, then completed on the
  same Device after restart
- Reconnect delivery send count: ${reconnect.deliverySendCount}
- Reconnect reply count: ${reconnect.replyCount}

## Sanitized metrics snapshot

${metricLines}

## Result

PASS
`;
}

export async function captureEvidence({ inputPath, databasePath, metricsPath, outputPath }) {
  const input = validateInput(JSON.parse(await readFile(inputPath, "utf8")));
  const metrics = parseMetrics(await readFile(metricsPath, "utf8"));
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  let output;
  try {
    const pairing = assertDatabaseScope(database, input);
    const online = inspectRun(database, input, "online");
    const reconnect = inspectRun(database, input, "reconnect");
    output = render(input, metrics, pairing, online, reconnect);
  } finally {
    database.close();
  }
  if (forbiddenEvidence.some((pattern) => pattern.test(output))) {
    fail("rendered output failed the final disclosure scan");
  }
  await writeFile(outputPath, output, { flag: "wx", mode: 0o600 });
  return output;
}

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!["--input", "--database", "--metrics", "--output"].includes(key) || !value) {
      fail("usage: capture-two-machine-onboarding-evidence --input file --database file --metrics file --output file");
    }
    result[key.slice(2)] = path.resolve(value);
  }
  if (Object.keys(result).length !== 4) fail("all four file arguments are required");
  return {
    inputPath: result.input,
    databasePath: result.database,
    metricsPath: result.metrics,
    outputPath: result.output
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  captureEvidence(parseArguments(process.argv.slice(2))).then(({ length }) => {
    process.stdout.write(`Verified and wrote ${length} bytes of sanitized QA-002 evidence.\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
