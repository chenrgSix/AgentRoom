import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import type {
  ExecutionPlanDefinition
} from "@convene-wire/contracts/execution-plan";

import {
  ExecutionNodeMaterializationRepository,
  type ExecutionNodeMaterialization
} from
  "../../apps/server/src/execution/execution-node-materialization-repository.js";
import {
  spawnTestProcess,
  type TestProcess
} from "../../scripts/test/child-process.mjs";
import {
  createTestResources,
  type TestResources
} from "../../scripts/test/resources.mjs";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const bridgeRoot = path.join(repositoryRoot, "bridge");
const permissionProfile = "convenewire_governed";

interface ProcessHandle extends TestProcess {
  stderr: string;
  stdout: string;
}

interface BindingView {
  bindingId: string;
  repositoryId: string;
  revision: number;
  sourceFingerprint: string;
}

interface RuntimeProfileView {
  digest: string;
  spec: {
    profileId: string;
    revision: number;
  };
}

interface VerificationProfileView {
  digest: string;
  profileId: string;
  revision: number;
}

interface AgentView {
  agentId: string;
  capabilities?: {
    governedExecution?: {
      readyGrants?: Array<{
        grant: { grantId: string };
      }>;
    };
  };
  name: string;
  presence: string;
}

interface ArtifactView {
  artifactId: string;
  artifactRevision: number;
  type: string;
  contentSha256: string | null;
  contentSizeBytes: number | null;
  sourceRunId: string | null;
}

interface RunView {
  runId: string;
  state: string;
  targetAgentId: string;
  taskId: string;
}

interface CleanupPreview {
  digest: string;
  path: string;
  branch: string;
  runId: string;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the physical two-Bridge state", {
    cause: lastError
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function startProcess(
  resources: TestResources,
  executable: string,
  args: string[],
  options: Parameters<typeof spawnTestProcess>[3]
): ProcessHandle {
  const processHandle = spawnTestProcess(resources, executable, args, options);
  const handle: ProcessHandle = { ...processHandle, stdout: "", stderr: "" };
  handle.process.stdout?.on("data", (source: Buffer) => {
    handle.stdout = (handle.stdout + source.toString()).slice(-8_000);
  });
  handle.process.stderr?.on("data", (source: Buffer) => {
    handle.stderr = (handle.stderr + source.toString()).slice(-8_000);
  });
  return handle;
}

function centralEnvironment(
  port: number,
  databasePath: string,
  bridgeServerToken: string
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of [
    "AGENT_ROOM_PORT",
    "AGENT_ROOM_HOST",
    "AGENT_ROOM_DATABASE_PATH",
    "AGENT_ROOM_BRIDGE_SERVER_TOKEN",
    "CONVENE_WIRE_DATA_DIR"
  ]) delete environment[key];
  return {
    ...environment,
    CONVENE_WIRE_PORT: String(port),
    CONVENE_WIRE_HOST: "127.0.0.1",
    CONVENE_WIRE_DATABASE_PATH: databasePath,
    CONVENE_WIRE_BRIDGE_SERVER_TOKEN: bridgeServerToken,
    CONVENE_WIRE_WEB_AUTH_MODE: "local"
  };
}

function startCentral(
  resources: TestResources,
  port: number,
  databasePath: string,
  bridgeServerToken: string
): ProcessHandle {
  return startProcess(resources, process.execPath, [
    "--import",
    "tsx",
    "apps/server/src/server.ts"
  ], {
    cwd: repositoryRoot,
    env: centralEnvironment(port, databasePath, bridgeServerToken),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function startBridge(
  resources: TestResources,
  bridgeBinary: string,
  configPath: string,
  role: "build" | "consume"
): ProcessHandle {
  return startProcess(resources, bridgeBinary, ["run", "--config", configPath], {
    env: { ...process.env, CONVENE_WIRE_E2E_ROLE: role },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function bridgeCommand(
  bridgeBinary: string,
  configPath: string,
  role: "build" | "consume",
  args: string[]
): Promise<string> {
  const result = await execFileAsync(bridgeBinary, [
    ...args,
    "--config",
    configPath
  ], {
    env: { ...process.env, CONVENE_WIRE_E2E_ROLE: role },
    maxBuffer: 4 << 20
  });
  return result.stdout;
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repository,
    maxBuffer: 8 << 20
  });
  return result.stdout.trim();
}

async function writeJSON(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

async function requestJSON<T>(
  serverUrl: string,
  method: string,
  pathname: string,
  payload?: unknown,
  token?: string
): Promise<T> {
  const response = await fetch(`${serverUrl}${pathname}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  const source = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned ${response.status}: ${source}`);
  }
  return JSON.parse(source) as T;
}

function databaseRead<T>(databasePath: string, read: (database: Database.Database) => T): T {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true
  });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function materialization(
  databasePath: string,
  planId: string,
  planRevision: number,
  nodeKey: string,
  gate: "verified_output" | "integrated_commit"
): ExecutionNodeMaterialization | undefined {
  return databaseRead(databasePath, (database) =>
    new ExecutionNodeMaterializationRepository(database).get({
      planId,
      planRevision,
      nodeKey
    }, gate));
}

async function createCodexFixture(
  directory: string
): Promise<{ executable: string; helper: string }> {
  const executable = path.join(directory, "codex");
  const helper = path.join(directory, "codex-fixture.mjs");
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  await writeFile(helper, [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import readline from 'node:readline';",
    "const roleArgument = process.argv.find((value) => value.startsWith('fixture-role='));",
    "const role = roleArgument?.slice('fixture-role='.length);",
    "const profile = {",
    "  description: null, extends: null, workspace_roots: null,",
    "  filesystem: {",
    "    glob_scan_max_depth: null, ':root': 'deny', ':minimal': 'read',",
    "    ':tmpdir': 'deny', ':slash_tmp': 'deny', ':workspace_roots': { '.': 'write' }",
    "  },",
    "  network: { enabled: false, domains: null }",
    "};",
    "const send = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);",
    "const inside = (cwd, target) => {",
    "  const relative = path.relative(cwd, target);",
    "  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);",
    "};",
    "for await (const line of readline.createInterface({ input: process.stdin })) {",
    "  const request = JSON.parse(line);",
    "  if (!request.id) continue;",
    "  if (request.method === 'initialize') {",
    "    send({ id: request.id, result: { userAgent: 'convenewire-physical-fixture' } });",
    "  } else if (request.method === 'permissionProfile/list') {",
    "    send({ id: request.id, result: { data: [{ id: 'convenewire_governed', allowed: true }], nextCursor: null } });",
    "  } else if (request.method === 'config/read') {",
    "    send({ id: request.id, result: { config: { permissions: { convenewire_governed: profile } } } });",
    "  } else if (request.method === 'command/exec') {",
    "    const command = request.params?.command ?? [];",
    "    const cwd = request.params?.cwd ?? '';",
    "    let exitCode = 1;",
    "    if (command[0] === '/usr/bin/nc' && command.length === 2 && command[1] === '-h') {",
    "      exitCode = 0;",
    "    } else if (command[0] === '/bin/sh') {",
    "      const target = command.at(-1);",
    "      if (typeof target === 'string' && inside(cwd, target)) {",
    "        await writeFile(target, 'permitted', { mode: 0o600 });",
    "        exitCode = 0;",
    "      }",
    "    }",
    "    send({ id: request.id, result: { exitCode, stdout: '', stderr: '' } });",
    "  } else if (request.method === 'thread/start') {",
    "    send({ id: request.id, result: { thread: { id: `thread-${role}`, ephemeral: false } } });",
    "  } else if (request.method === 'turn/start') {",
    "    const cwd = process.cwd();",
    "    await mkdir(path.join(cwd, 'src'), { recursive: true });",
    "    if (role === 'build') {",
    "      const before = await readFile(path.join(cwd, 'src/dependency.ts'), 'utf8');",
    "      if (before !== \"export const state = 'old';\\n\") process.exit(31);",
    "      await writeFile(path.join(cwd, 'src/dependency.ts'), \"export const state = 'integrated';\\n\");",
    "    } else if (role === 'consume') {",
    "      const dependency = await readFile(path.join(cwd, 'src/dependency.ts'), 'utf8');",
    "      if (dependency !== \"export const state = 'integrated';\\n\") process.exit(32);",
    "      await writeFile(path.join(cwd, 'src/downstream.ts'), \"export const observed = 'integrated';\\n\");",
    "    } else {",
    "      process.exit(33);",
    "    }",
    "    const turnId = `turn-${role}`;",
    "    const threadId = request.params.threadId;",
    "    send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });",
    "    send({ method: 'item/completed', params: { threadId, turnId, item: {",
    "      id: `item-${role}`, type: 'agentMessage', text: `physical ${role} completed`",
    "    } } });",
    "    send({ method: 'turn/completed', params: { threadId, turn: {",
    "      id: turnId, status: 'completed', items: []",
    "    } } });",
    "  }",
    "}"
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return { executable, helper };
}

async function createVerifier(directory: string): Promise<string> {
  const verifier = path.join(directory, "verify-build.mjs");
  await writeFile(verifier, [
    "import { readFile } from 'node:fs/promises';",
    "const content = await readFile('src/dependency.ts', 'utf8');",
    "if (content !== \"export const state = 'integrated';\\n\") {",
    "  process.stderr.write('candidate did not contain the integrated dependency');",
    "  process.exit(1);",
    "}",
    "process.stdout.write('independent candidate verification passed');"
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return verifier;
}

async function waitForAgent(
  serverUrl: string,
  token: string,
  teamId: string,
  name: string,
  ready = false
): Promise<AgentView> {
  return waitFor(async () => {
    const agents = await requestJSON<AgentView[]>(
      serverUrl,
      "GET",
      `/api/teams/${teamId}/agents`,
      undefined,
      token
    );
    return agents.find((agent) =>
      agent.name === name && (!ready || agent.presence === "ready"));
  });
}

async function waitForAgentGrant(
  serverUrl: string,
  token: string,
  teamId: string,
  name: string,
  grantId: string
): Promise<AgentView> {
  return waitFor(async () => {
    const agents = await requestJSON<AgentView[]>(
      serverUrl,
      "GET",
      `/api/teams/${teamId}/agents`,
      undefined,
      token
    );
    return agents.find((agent) => agent.name === name &&
      agent.capabilities?.governedExecution?.readyGrants?.some(
        (grant) => grant.grant.grantId === grantId
      ));
  });
}

async function setTaskActive(
  serverUrl: string,
  token: string,
  taskId: string,
  suffix: string
): Promise<any> {
  let task = await requestJSON<any>(serverUrl, "GET", `/api/tasks/${taskId}`, undefined, token);
  task = await requestJSON<any>(serverUrl, "POST", `/api/tasks/${taskId}/control`, {
    operationId: `op_run018_task_ready_${suffix}`,
    expectedTaskRevision: task.taskRevision,
    lifecycleState: "ready"
  }, token);
  return requestJSON<any>(serverUrl, "POST", `/api/tasks/${taskId}/control`, {
    operationId: `op_run018_task_active_${suffix}`,
    expectedTaskRevision: task.taskRevision,
    lifecycleState: "active"
  }, token);
}

async function proposeResult(
  bridgeBinary: string,
  configPath: string,
  role: "build" | "consume",
  agentName: string,
  run: RunView,
  task: any,
  artifact: ArtifactView,
  completedSequence: number,
  suffix: string
): Promise<string> {
  const criterion = task.criteria.find((candidate: { required: boolean }) => candidate.required);
  assert.ok(criterion);
  return bridgeCommand(bridgeBinary, configPath, role, [
    "result",
    "propose",
    "--agent",
    agentName,
    "--run-id",
    run.runId,
    "--proposal-json",
    JSON.stringify({
      operationId: `op_run018_result_${suffix}`,
      taskId: task.taskId,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision,
      proposedAtTaskRevision: task.taskRevision,
      supersedesResultId: null,
      outcome: "satisfied",
      summary: `Physical ${role} checkpoint is available.`,
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: `evidence_run018_artifact_${suffix}`,
        kind: "artifact",
        artifactId: artifact.artifactId
      }, {
        evidenceRefId: `evidence_run018_run_${suffix}`,
        kind: "run_event",
        runId: run.runId,
        sequence: completedSequence
      }],
      criterionClaims: [{
        criterionKey: criterion.criterionKey,
        coverage: "satisfied",
        explanation: "The canonical checkpoint contains the required bounded output.",
        evidenceRefIds: [`evidence_run018_artifact_${suffix}`]
      }]
    })
  ]);
}

test("real Central and two Bridges carry one integrated_commit dependency", {
  timeout: 240_000,
  skip: process.platform !== "darwin" ? "native governed Codex boundary is macOS-only" : false
}, async (t) => {
  const resources = await createTestResources(t, "convene-wire-two-bridge-e2e-");
  const directory = resources.directory;
  const serverDatabase = path.join(directory, "central.sqlite");
  const sourceA = path.join(directory, "source-a");
  const sourceB = path.join(directory, "source-b");
  const dataA = path.join(directory, "bridge-a-data");
  const dataB = path.join(directory, "bridge-b-data");
  const configA = path.join(directory, "bridge-a.json");
  const configB = path.join(directory, "bridge-b.json");
  const bridgeBinary = path.join(directory, "convenewire-bridge");
  const bridgeServerToken = `run018-${"central-token-".repeat(3)}0001`;
  const repositoryId = "repo_run018_physical0001";
  const bindingIdA = "repobind_run018_bridge_a0001";
  const bindingIdB = "repobind_run018_bridge_b0001";
  const runtimeProfileIdA = "profile_run018_runtime_a0001";
  const runtimeProfileIdB = "profile_run018_runtime_b0001";
  const verifierProfileIdA = "profile_run018_verifier_a0001";
  const verifierProfileIdB = "profile_run018_verifier_b0001";
  const agentNameA = "Physical Builder A";
  const agentNameB = "Physical Consumer B";
  const targetRef = "refs/heads/integrated";
  let central: ProcessHandle | undefined;
  let bridgeA: ProcessHandle | undefined;
  let bridgeB: ProcessHandle | undefined;
  const processHistory: ProcessHandle[] = [];
  let stage = "initialize physical fixture";

  try {
    await mkdir(path.join(sourceA, "src"), { recursive: true });
    await writeFile(
      path.join(sourceA, "src/dependency.ts"),
      "export const state = 'old';\n"
    );
    await execFileAsync("git", ["init", "--initial-branch=main", sourceA]);
    await git(sourceA, ["config", "user.name", "ConveneWire E2E"]);
    await git(sourceA, ["config", "user.email", "e2e@convenewire.invalid"]);
    await git(sourceA, ["add", "--all"]);
    await git(sourceA, ["commit", "-m", "base"]);
    const baseCommit = await git(sourceA, ["rev-parse", "HEAD"]);
    const baseTree = await git(sourceA, ["rev-parse", "HEAD^{tree}"]);
    await git(sourceA, ["update-ref", targetRef, baseCommit]);
    await execFileAsync("git", ["clone", "--no-local", sourceA, sourceB]);
    await git(sourceB, ["config", "user.name", "ConveneWire E2E"]);
    await git(sourceB, ["config", "user.email", "e2e@convenewire.invalid"]);

    const codex = await createCodexFixture(directory);
    const verifier = await createVerifier(directory);
    const goBinary = process.env.CONVENE_WIRE_GO_BIN ?? "go";
    await execFileAsync(goBinary, [
      "build",
      "-o",
      bridgeBinary,
      "./cmd/convenewire-bridge"
    ], { cwd: bridgeRoot, maxBuffer: 8 << 20 });

    const port = await reservePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    central = startCentral(resources, port, serverDatabase, bridgeServerToken);
    processHistory.push(central);
    stage = "wait for actual Central";
    await waitFor(async () => {
      const response = await fetch(`${serverUrl}/api/health/ready`);
      return response.ok ? true : undefined;
    });

    const bootstrap = await requestJSON<any>(serverUrl, "POST", "/api/bootstrap", {
      displayName: "RUN-018 Owner"
    });
    const webToken = bootstrap.session.token as string;
    const team = await requestJSON<any>(serverUrl, "POST", "/api/teams", {
      name: "RUN-018 Physical Team"
    }, webToken);
    const teamId = team.team.teamId as string;
    const ownerMemberId = team.owner.memberId as string;
    const room = await requestJSON<any>(
      serverUrl,
      "POST",
      `/api/teams/${teamId}/rooms`,
      { name: "physical-handoff" },
      webToken
    );
    const roomId = room.roomId as string;

    const bridgeConfig = (
      dataDir: string,
      deviceName: string,
      agentName: string,
      source: string,
      role: "build" | "consume"
    ) => ({
      schemaVersion: 5,
      serverUrl,
      serverToken: bridgeServerToken,
      deviceName,
      dataDir,
      agents: [{
        name: agentName,
        role: "Governed implementation",
        adapter: "codex",
        runtimeKind: "codex",
        presetVersion: 5,
        command: [
          codex.executable,
          codex.helper,
          `fixture-role=${role}`,
          "app-server",
          "--listen",
          "stdio://"
        ],
        workspace: source,
        workspaceAlias: path.basename(source),
        sandbox: "workspace-write",
        codexSessionConflictPolicy: "preserve_and_retry",
        envAllowlist: []
      }]
    });
    await writeJSON(configA, bridgeConfig(
      dataA,
      "Physical Bridge A",
      agentNameA,
      sourceA,
      "build"
    ));
    await writeJSON(configB, bridgeConfig(
      dataB,
      "Physical Bridge B",
      agentNameB,
      sourceB,
      "consume"
    ));

    for (const [deviceName, configPath, role] of [
      ["Physical Bridge A", configA, "build"],
      ["Physical Bridge B", configB, "consume"]
    ] as const) {
      const invite = await requestJSON<any>(
        serverUrl,
        "POST",
        `/api/teams/${teamId}/bridge-invites`,
        { deviceName },
        webToken
      );
      await bridgeCommand(bridgeBinary, configPath, role, ["pair", "--code", invite.code]);
    }

    stage = "provision two stable Agent identities through actual Bridges";
    bridgeA = startBridge(resources, bridgeBinary, configA, "build");
    bridgeB = startBridge(resources, bridgeBinary, configB, "consume");
    processHistory.push(bridgeA, bridgeB);
    const agentA = await waitForAgent(serverUrl, webToken, teamId, agentNameA);
    const agentB = await waitForAgent(serverUrl, webToken, teamId, agentNameB);
    await Promise.all([bridgeA.stop(), bridgeB.stop()]);
    bridgeA = undefined;
    bridgeB = undefined;

    stage = "register exact owner-local bindings and profiles";
    const bindingA = JSON.parse(await bridgeCommand(bridgeBinary, configA, "build", [
      "repository", "bind",
      "--binding-id", bindingIdA,
      "--repository-id", repositoryId,
      "--alias", "Physical source A",
      "--workspace", sourceA,
      "--allowed-root", sourceA,
      "--confirm"
    ])) as BindingView;
    const bindingB = JSON.parse(await bridgeCommand(bridgeBinary, configB, "consume", [
      "repository", "bind",
      "--binding-id", bindingIdB,
      "--repository-id", repositoryId,
      "--alias", "Physical source B",
      "--workspace", sourceB,
      "--allowed-root", sourceB,
      "--confirm"
    ])) as BindingView;
    const runtimeA = JSON.parse(await bridgeCommand(bridgeBinary, configA, "build", [
      "repository", "profile", "register",
      "--profile-id", runtimeProfileIdA,
      "--agent-id", agentA.agentId,
      "--permission-profile", permissionProfile,
      "--confirm"
    ])) as RuntimeProfileView;
    const runtimeB = JSON.parse(await bridgeCommand(bridgeBinary, configB, "consume", [
      "repository", "profile", "register",
      "--profile-id", runtimeProfileIdB,
      "--agent-id", agentB.agentId,
      "--permission-profile", permissionProfile,
      "--confirm"
    ])) as RuntimeProfileView;
    const verifierSpec = path.join(directory, "verifier-profile.json");
    await writeJSON(verifierSpec, {
      profileId: verifierProfileIdA,
      revision: 1,
      command: [process.execPath, verifier],
      environmentNames: [],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 16_384
    });
    const verifierProfileA = JSON.parse(await bridgeCommand(
      bridgeBinary,
      configA,
      "build",
      ["repository", "verifier", "register", "--file", verifierSpec, "--confirm"]
    )) as VerificationProfileView;
    await writeJSON(verifierSpec, {
      profileId: verifierProfileIdB,
      revision: 1,
      command: [process.execPath, verifier],
      environmentNames: [],
      timeoutMilliseconds: 10_000,
      outputLimitBytes: 16_384
    });
    const verifierProfileB = JSON.parse(await bridgeCommand(
      bridgeBinary,
      configB,
      "consume",
      ["repository", "verifier", "register", "--file", verifierSpec, "--confirm"]
    )) as VerificationProfileView;

    stage = "freeze and approve the exact integrated dependency plan";
    await requestJSON<any>(serverUrl, "PUT", `/api/rooms/${roomId}/participants`, {
      memberIds: [ownerMemberId],
      agentIds: [agentA.agentId, agentB.agentId]
    }, webToken);
    const rootTask = await requestJSON<any>(serverUrl, "POST", `/api/rooms/${roomId}/tasks`, {
      title: "Physical integrated dependency",
      goal: "Build on Bridge A and consume only the integrated proof on Bridge B."
    }, webToken);
    const sourceMessage = await requestJSON<any>(serverUrl, "POST", `/api/rooms/${roomId}/messages`, {
      taskId: rootTask.taskId,
      content: "Execute the frozen two-Bridge integrated dependency."
    }, webToken);
    const currentRoot = await requestJSON<any>(
      serverUrl,
      "GET",
      `/api/tasks/${rootTask.taskId}`,
      undefined,
      webToken
    );
    const fixtureCases = JSON.parse(await readFile(path.join(
      repositoryRoot,
      "packages/contracts/fixtures/execution-plan-cases.json"
    ), "utf8"));
    const template = fixtureCases.cases.find((entry: { name: string }) =>
      entry.name === "execution: valid full plan").instance as ExecutionPlanDefinition;
    const definition = structuredClone(template) as any;
    definition.rootTaskId = rootTask.taskId;
    definition.title = "Physical integrated_commit handoff";
    definition.decision = {
      summary: "Use proof-gated local integration before downstream execution.",
      items: [{
        itemKey: "authority",
        statement: "Only the exact integrated_commit proof unlocks Bridge B."
      }],
      unresolvedQuestions: [],
      sources: [{
        evidenceRefId: "evidence_run018_source0001",
        kind: "message",
        messageId: sourceMessage.message.messageId
      }],
      sourceRevisions: [{
        evidenceRefId: "evidence_run018_source0001",
        revision: sourceMessage.message.sequence
      }]
    };
    const buildNode = definition.nodes[0];
    const consumeNode = definition.nodes[1];
    buildNode.nodeKey = "Build";
    buildNode.kind = "implementation";
    buildNode.task = {
      mode: "new",
      title: "Build physical candidate",
      goal: "Produce the exact verified candidate on Bridge A.",
      ownerMemberId,
      criteria: [{
        criterionKey: "criterion_run018_build0001",
        description: "Canonical verified candidate is retained.",
        required: true,
        ordinal: 1
      }]
    };
    buildNode.agentId = agentA.agentId;
    buildNode.repository = {
      repositoryId,
      bindingId: bindingIdA,
      baseCommit,
      grantId: "grant_run018_build0001",
      grantRevision: 1,
      runtimeProfileId: runtimeProfileIdA,
      runtimeProfileDigest: runtimeA.digest
    };
    buildNode.scope = {
      access: "isolated_write",
      allowedPaths: ["src"],
      forbiddenPaths: ["secrets"],
      requirePreventivePathEnforcement: false
    };
    buildNode.verificationProfiles = [{
      profileId: verifierProfileA.profileId,
      revision: verifierProfileA.revision,
      digest: verifierProfileA.digest,
      required: true
    }];
    buildNode.inputs = [];
    buildNode.outputs = [{ slotKey: "output", kind: "patch", required: true }];
    consumeNode.nodeKey = "Consume";
    consumeNode.kind = "implementation";
    consumeNode.task = {
      mode: "new",
      title: "Consume integrated candidate",
      goal: "Continue only from the exact Bridge A integrated bytes.",
      ownerMemberId,
      criteria: [{
        criterionKey: "criterion_run018_consume0001",
        description: "Integrated dependency is consumed and extended.",
        required: true,
        ordinal: 1
      }]
    };
    consumeNode.agentId = agentB.agentId;
    consumeNode.repository = {
      repositoryId,
      bindingId: bindingIdB,
      baseCommit,
      grantId: "grant_run018_consume0001",
      grantRevision: 1,
      runtimeProfileId: runtimeProfileIdB,
      runtimeProfileDigest: runtimeB.digest
    };
    consumeNode.scope = structuredClone(buildNode.scope);
    consumeNode.verificationProfiles = [{
      profileId: verifierProfileB.profileId,
      revision: verifierProfileB.revision,
      digest: verifierProfileB.digest,
      required: true
    }];
    consumeNode.inputs = [{ slotKey: "patch", kind: "patch", required: true }];
    consumeNode.outputs = [{ slotKey: "output", kind: "patch", required: true }];
    definition.edges = [{
      edgeKey: "build_consume",
      fromNodeKey: "Build",
      toNodeKey: "Consume",
      gate: "integrated_commit",
      bindings: [{ outputSlot: "output", inputSlot: "patch" }]
    }];
    definition.policy = {
      maxConcurrency: 1,
      budget: { maxRunAttempts: 2, maxExecutionDurationSeconds: 3_600 },
      integration: "local_integration",
      requireHumanIntegrationApproval: true,
      integrationTargets: [{ repositoryId, targetRef, expectedCommit: baseCommit }]
    };
    const draft = await requestJSON<any>(
      serverUrl,
      "POST",
      `/api/tasks/${rootTask.taskId}/execution-plans`,
      {
        operationId: "op_run018_plan_create0001",
        expectedRootTaskRevision: currentRoot.taskRevision,
        definition
      },
      webToken
    );
    const approval = await requestJSON<any>(
      serverUrl,
      "POST",
      `/api/execution-plans/${draft.planId}/approvals`,
      {
        operationId: "op_run018_plan_approval0001",
        expectedRevision: draft.current.revision,
        expectedDigest: draft.current.digest,
        expectedRootTaskRevision: currentRoot.taskRevision,
        decision: "approved",
        reason: "Authorize this exact physical two-Bridge handoff."
      },
      webToken
    );
    const plan = approval.plan;
    const tasksByNode = new Map<string, any>();
    for (const compiled of plan.compiledTasks as Array<{ nodeKey: string; taskId: string }>) {
      tasksByNode.set(compiled.nodeKey, await setTaskActive(
        serverUrl,
        webToken,
        compiled.taskId,
        compiled.nodeKey.toLowerCase()
      ));
    }
    const buildTask = tasksByNode.get("Build");
    const consumeTask = tasksByNode.get("Consume");
    assert.ok(buildTask && consumeTask);

    stage = "issue exact task and integration grants";
    // Governed admission reserves the production Run's 20-minute deadline.
    // Keep the owner grant wider than that reservation while remaining
    // intentionally short-lived for this disposable acceptance fixture.
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const commonGrant = {
      bindingRevision: 1,
      repositoryId,
      baseCommit,
      planId: plan.planId,
      planRevision: plan.current.revision,
      planDigest: plan.current.digest,
      roomId,
      expiresAt,
      scopePolicy: structuredClone(buildNode.scope)
    };
    const buildGrantFile = path.join(directory, "build-grant.json");
    await writeJSON(buildGrantFile, {
      ...commonGrant,
      grantId: buildNode.repository.grantId,
      bindingId: bindingIdA,
      sourceFingerprint: bindingA.sourceFingerprint,
      nodeKey: "Build",
      taskId: buildTask.taskId,
      definitionRevision: buildTask.definitionRevision,
      criteriaRevision: buildTask.criteriaRevision,
      agentId: agentA.agentId,
      operations: ["prepare", "capture", "verify"],
      runtimeProfile: {
        profileId: runtimeProfileIdA,
        revision: runtimeA.spec.revision,
        digest: runtimeA.digest
      },
      verificationProfiles: [{
        profileId: verifierProfileA.profileId,
        revision: verifierProfileA.revision,
        digest: verifierProfileA.digest
      }],
      integrationTargets: []
    });
    const consumeGrantFile = path.join(directory, "consume-grant.json");
    await writeJSON(consumeGrantFile, {
      ...commonGrant,
      grantId: consumeNode.repository.grantId,
      bindingId: bindingIdB,
      sourceFingerprint: bindingB.sourceFingerprint,
      nodeKey: "Consume",
      taskId: consumeTask.taskId,
      definitionRevision: consumeTask.definitionRevision,
      criteriaRevision: consumeTask.criteriaRevision,
      agentId: agentB.agentId,
      operations: ["prepare", "capture", "verify"],
      runtimeProfile: {
        profileId: runtimeProfileIdB,
        revision: runtimeB.spec.revision,
        digest: runtimeB.digest
      },
      verificationProfiles: [{
        profileId: verifierProfileB.profileId,
        revision: verifierProfileB.revision,
        digest: verifierProfileB.digest
      }],
      integrationTargets: []
    });
    const integrationGrantFile = path.join(directory, "integration-grant.json");
    await writeJSON(integrationGrantFile, {
      ...commonGrant,
      grantId: "grant_run018_integrate0001",
      bindingId: bindingIdA,
      sourceFingerprint: bindingA.sourceFingerprint,
      nodeKey: "Build",
      taskId: buildTask.taskId,
      definitionRevision: buildTask.definitionRevision,
      criteriaRevision: buildTask.criteriaRevision,
      agentId: agentA.agentId,
      operations: ["integrate"],
      runtimeProfile: {
        profileId: runtimeProfileIdA,
        revision: runtimeA.spec.revision,
        digest: runtimeA.digest
      },
      verificationProfiles: [{
        profileId: verifierProfileA.profileId,
        revision: verifierProfileA.revision,
        digest: verifierProfileA.digest
      }],
      integrationTargets: [{ repositoryId, targetRef, expectedCommit: baseCommit }]
    });
    await bridgeCommand(bridgeBinary, configA, "build", [
      "repository", "grant", "issue", "--file", buildGrantFile, "--confirm"
    ]);
    await bridgeCommand(bridgeBinary, configB, "consume", [
      "repository", "grant", "issue", "--file", consumeGrantFile, "--confirm"
    ]);
    stage = "run Bridge A through capture and independent verification";
    bridgeA = startBridge(resources, bridgeBinary, configA, "build");
    bridgeB = startBridge(resources, bridgeBinary, configB, "consume");
    processHistory.push(bridgeA, bridgeB);
    await waitForAgentGrant(
      serverUrl,
      webToken,
      teamId,
      agentNameA,
      buildNode.repository.grantId
    );
    await waitForAgentGrant(
      serverUrl,
      webToken,
      teamId,
      agentNameB,
      consumeNode.repository.grantId
    );
    let buildRun: RunView;
    try {
      buildRun = await waitFor(async () => {
        const runs = await requestJSON<RunView[]>(
          serverUrl,
          "GET",
          `/api/rooms/${roomId}/runs`,
          undefined,
          webToken
        );
        return runs.find((run) =>
          run.taskId === buildTask.taskId &&
          ["completed", "failed", "canceled", "expired", "outcome_unknown"]
            .includes(run.state));
      }, 90_000);
      assert.equal(buildRun.state, "completed");
    } catch (error) {
      const snapshot = databaseRead(serverDatabase, (database) => ({
        nodes: database.prepare(`
          SELECT node_key, state, blocker_code, run_id
          FROM execution_node_states WHERE plan_id = ? ORDER BY node_key
        `).all(plan.planId),
        dispatches: database.prepare(`
          SELECT node_key, run_id FROM execution_dispatch_intents
          WHERE plan_id = ? ORDER BY node_key
        `).all(plan.planId),
        runs: database.prepare(`
          SELECT run_id, task_id, target_agent_id, state FROM runs
          WHERE task_id IN (?, ?) ORDER BY created_at
        `).all(buildTask.taskId, consumeTask.taskId),
        events: database.prepare(`
          SELECT sequence, event_type, status, content, error_json, activity_json
          FROM run_events
          WHERE run_id IN (
            SELECT run_id FROM runs WHERE task_id IN (?, ?)
          ) ORDER BY run_id, sequence
        `).all(buildTask.taskId, consumeTask.taskId),
        agents: database.prepare(`
          SELECT agent_id, name, presence, capabilities_json FROM agents
          WHERE agent_id IN (?, ?) ORDER BY name
        `).all(agentA.agentId, agentB.agentId)
      }));
      throw new Error(`Build did not complete: ${JSON.stringify(snapshot)}`, {
        cause: error
      });
    }
    const buildArtifacts = await requestJSON<{ artifacts: ArtifactView[] }>(
      serverUrl,
      "GET",
      `/api/tasks/${buildTask.taskId}/artifacts`,
      undefined,
      webToken
    );
    const buildArtifact = buildArtifacts.artifacts.find((artifact) =>
      artifact.sourceRunId === buildRun.runId &&
      artifact.type === "patch" &&
      artifact.contentSha256);
    assert.ok(buildArtifact);
    const buildEvents = await requestJSON<Array<{
      sequence: number;
      event: { type: string; status?: string };
    }>>(serverUrl, "GET", `/api/runs/${buildRun.runId}/events?after=0`, undefined, webToken);
    const buildCompleted = buildEvents.find(({ event }) =>
      event.type === "status" && event.status === "completed");
    assert.ok(buildCompleted);
    const proposedBuild = await proposeResult(
      bridgeBinary,
      configA,
      "build",
      agentNameA,
      buildRun,
      buildTask,
      buildArtifact,
      buildCompleted.sequence,
      "build0001"
    );
    assert.match(proposedBuild, /proposed Result result_/u);
    let verified: ExecutionNodeMaterialization;
    try {
      verified = await waitFor(async () => materialization(
        serverDatabase,
        plan.planId,
        plan.current.revision,
        "Build",
        "verified_output"
      ));
    } catch (error) {
      const snapshot = databaseRead(serverDatabase, (database) => ({
        results: database.prepare(`
          SELECT result_id, task_id, proposed_by_kind, proposed_by_agent_id,
            proposed_by_run_id, state, result_version
          FROM task_results WHERE task_id = ?
        `).all(buildTask.taskId),
        evidence: database.prepare(`
          SELECT result_id, evidence_kind, artifact_id, run_id, run_sequence
          FROM result_evidence_refs WHERE result_id IN (
            SELECT result_id FROM task_results WHERE task_id = ?
          ) ORDER BY evidence_kind
        `).all(buildTask.taskId),
        captures: database.prepare(`
          SELECT operation_id, json_extract(request_json, '$.execution.runId') AS run_id
          FROM repository_capture_operations
        `).all(),
        checkpoints: database.prepare(`
          SELECT checkpoint_id, operation_id FROM repository_checkpoints
        `).all(),
        outputs: database.prepare(`
          SELECT checkpoint_id, slot_key, artifact_id, artifact_revision
          FROM repository_checkpoint_outputs
        `).all(),
        verifications: database.prepare(`
          SELECT operation_id, checkpoint_id, profile_id, profile_revision,
            profile_digest FROM repository_verification_operations
        `).all(),
        receipts: database.prepare(`
          SELECT verification_id, operation_id, outcome FROM verification_receipts
        `).all()
      }));
      throw new Error(`Verified materialization was not retained: ${JSON.stringify(snapshot)}`, {
        cause: error
      });
    }
    assert.equal(verified.gate, "verified_output");
    assert.equal(verified.artifactPins[0]?.contentDigest, buildArtifact.contentSha256);

    stage = "restart the actual Central and reconcile retained proof";
    await central.stop();
    central = startCentral(resources, port, serverDatabase, bridgeServerToken);
    processHistory.push(central);
    await waitFor(async () => {
      const response = await fetch(`${serverUrl}/api/health/ready`);
      return response.ok ? true : undefined;
    });
    await waitForAgent(serverUrl, webToken, teamId, agentNameB, true);
    const replayedVerified = await waitFor(async () => materialization(
      serverDatabase,
      plan.planId,
      plan.current.revision,
      "Build",
      "verified_output"
    ));
    assert.equal(replayedVerified.materializationDigest, verified.materializationDigest);

    stage = "publish the separate integration grant";
    await bridgeA.stop();
    bridgeA = undefined;
    await bridgeCommand(bridgeBinary, configA, "build", [
      "repository", "grant", "issue", "--file", integrationGrantFile, "--confirm"
    ]);
    bridgeA = startBridge(resources, bridgeBinary, configA, "build");
    processHistory.push(bridgeA);
    await waitForAgentGrant(
      serverUrl,
      webToken,
      teamId,
      agentNameA,
      "grant_run018_integrate0001"
    );

    stage = "approve and execute exact-target CAS integration";
    const target = definition.policy.integrationTargets[0];
    const integrationApproval = await requestJSON<any>(
      serverUrl,
      "POST",
      `/api/execution-plans/${plan.planId}/integration-approvals`,
      {
        operationId: "op_run018_integration_approval0001",
        planId: plan.planId,
        planRevision: plan.current.revision,
        nodeKey: "Build",
        materializationDigest: replayedVerified.materializationDigest,
        candidateCommit: replayedVerified.candidateCommit,
        candidateTree: replayedVerified.candidateTree,
        inputDigest: replayedVerified.inputDigest,
        target,
        verificationReceipts: replayedVerified.verificationReceipts.map((receipt) => ({
          verificationId: receipt.verificationId,
          receiptDigest: receipt.receiptDigest
        })),
        deadline: new Date(Date.now() + 5 * 60_000).toISOString()
      },
      webToken
    );
    await bridgeA.stop();
    bridgeA = undefined;
    const integrationOutput = await bridgeCommand(bridgeBinary, configA, "build", [
      "repository", "integration", "execute",
      "--operation-id", integrationApproval.integrationOperationId,
      "--confirm"
    ]);
    const integrationReceipt = JSON.parse(integrationOutput);
    assert.equal(integrationReceipt.receipt.state, "succeeded");
    assert.equal(
      await git(sourceA, ["show-ref", "--verify", "--hash", targetRef]),
      replayedVerified.candidateCommit
    );
    assert.equal(await git(sourceA, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(await git(sourceA, ["rev-parse", "HEAD^{tree}"]), baseTree);
    assert.equal(
      await readFile(path.join(sourceA, "src/dependency.ts"), "utf8"),
      "export const state = 'old';\n"
    );
    assert.equal(await git(sourceA, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const integrated = await waitFor(async () => materialization(
      serverDatabase,
      plan.planId,
      plan.current.revision,
      "Build",
      "integrated_commit"
    ));
    assert.equal(integrated.gate, "integrated_commit");
    assert.equal(integrated.candidateCommit, replayedVerified.candidateCommit);
    assert.equal(integrated.verifiedMaterializationDigest, replayedVerified.materializationDigest);

    stage = "run Bridge B from the exact integrated bytes";
    const consumeRun = await waitFor(async () => {
      const runs = await requestJSON<RunView[]>(
        serverUrl,
        "GET",
        `/api/rooms/${roomId}/runs`,
        undefined,
        webToken
      );
      return runs.find((run) =>
        run.taskId === consumeTask.taskId && run.state === "completed");
    }, 90_000);
    const consumeArtifacts = await requestJSON<{ artifacts: ArtifactView[] }>(
      serverUrl,
      "GET",
      `/api/tasks/${consumeTask.taskId}/artifacts`,
      undefined,
      webToken
    );
    const consumeArtifact = consumeArtifacts.artifacts.find((artifact) =>
      artifact.sourceRunId === consumeRun.runId &&
      artifact.type === "patch" &&
      artifact.contentSha256);
    assert.ok(consumeArtifact);
    const consumeEvents = await requestJSON<Array<{
      sequence: number;
      event: { type: string; status?: string };
    }>>(serverUrl, "GET", `/api/runs/${consumeRun.runId}/events?after=0`, undefined, webToken);
    const consumeCompleted = consumeEvents.find(({ event }) =>
      event.type === "status" && event.status === "completed");
    assert.ok(consumeCompleted);
    const proposedConsume = await proposeResult(
      bridgeBinary,
      configB,
      "consume",
      agentNameB,
      consumeRun,
      consumeTask,
      consumeArtifact,
      consumeCompleted.sequence,
      "consume0001"
    );
    assert.match(proposedConsume, /proposed Result result_/u);
    await bridgeB.stop();
    bridgeB = undefined;

    stage = "preview and retire both exact stopped worktrees";
    const checkpointRows = databaseRead(serverDatabase, (database) => database.prepare(`
      SELECT checkpoint_json FROM repository_checkpoints
      WHERE json_extract(checkpoint_json, '$.scope.runId') IN (?, ?)
      ORDER BY json_extract(checkpoint_json, '$.scope.runId')
    `).all(buildRun.runId, consumeRun.runId) as Array<{ checkpoint_json: string }>);
    assert.equal(checkpointRows.length, 2);
    const checkpoints = new Map(checkpointRows.map((row) => {
      const checkpoint = JSON.parse(row.checkpoint_json);
      return [checkpoint.scope.runId as string, checkpoint];
    }));
    const cleanup = async (
      role: "build" | "consume",
      configPath: string,
      run: RunView,
      suffix: string
    ) => {
      const checkpoint = checkpoints.get(run.runId);
      assert.ok(checkpoint);
      const checkpointFile = path.join(directory, `checkpoint-${suffix}.json`);
      await writeJSON(checkpointFile, checkpoint);
      const grantId = `cleanupgrant_run018_${suffix}`;
      const operationId = `op_cleanup_run018_${suffix}`;
      await bridgeCommand(bridgeBinary, configPath, role, [
        "repository", "cleanup", "grant", "issue",
        "--grant-id", grantId,
        "--operation-id", operationId,
        "--checkpoint-file", checkpointFile,
        "--expires-at", expiresAt,
        "--confirm"
      ]);
      const preview = JSON.parse(await bridgeCommand(bridgeBinary, configPath, role, [
        "repository", "cleanup", "preview",
        "--grant-id", grantId,
        "--operation-id", operationId,
        "--checkpoint-file", checkpointFile
      ])) as CleanupPreview;
      await access(preview.path);
      assert.equal(
        await readFile(path.join(preview.path, "src/dependency.ts"), "utf8"),
        "export const state = 'integrated';\n"
      );
      if (role === "consume") {
        assert.equal(
          await readFile(path.join(preview.path, "src/downstream.ts"), "utf8"),
          "export const observed = 'integrated';\n"
        );
      }
      const executeArgs = [
        "repository", "cleanup", "execute",
        "--grant-id", grantId,
        "--operation-id", operationId,
        "--checkpoint-file", checkpointFile,
        "--expected-preview-digest", preview.digest,
        "--confirm"
      ];
      const receipt = JSON.parse(await bridgeCommand(
        bridgeBinary,
        configPath,
        role,
        executeArgs
      ));
      await assert.rejects(access(preview.path), { code: "ENOENT" });
      const replay = JSON.parse(await bridgeCommand(
        bridgeBinary,
        configPath,
        role,
        executeArgs
      ));
      assert.deepEqual(replay, receipt);
      return { preview, receipt };
    };
    const cleanedA = await cleanup("build", configA, buildRun, "bridge_a0001");
    const cleanedB = await cleanup("consume", configB, consumeRun, "bridge_b0001");
    assert.notEqual(cleanedA.preview.path, cleanedB.preview.path);

    stage = "inspect physical Git and SQLite evidence";
    assert.equal(await git(sourceB, ["rev-parse", "HEAD"]), baseCommit);
    assert.equal(
      await readFile(path.join(sourceB, "src/dependency.ts"), "utf8"),
      "export const state = 'old';\n"
    );
    assert.equal(await git(sourceB, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    const evidence = databaseRead(serverDatabase, (database) => ({
      dispatches: (database.prepare(`
        SELECT count(*) AS count FROM execution_dispatch_intents WHERE plan_id = ?
      `).get(plan.planId) as { count: number }).count,
      completedRuns: (database.prepare(`
        SELECT count(*) AS count FROM runs
        WHERE task_id IN (?, ?) AND state = 'completed'
      `).get(buildTask.taskId, consumeTask.taskId) as { count: number }).count,
      results: (database.prepare(`
        SELECT count(*) AS count FROM task_results WHERE task_id IN (?, ?)
      `).get(buildTask.taskId, consumeTask.taskId) as { count: number }).count,
      passedVerifications: (database.prepare(`
        SELECT count(*) AS count FROM verification_receipts WHERE outcome = 'passed'
      `).get() as { count: number }).count,
      succeededIntegrations: (database.prepare(`
        SELECT count(*) AS count FROM integration_receipts WHERE state = 'succeeded'
      `).get() as { count: number }).count,
      integratedMaterializations: (database.prepare(`
        SELECT count(*) AS count FROM execution_integrated_node_materializations
        WHERE plan_id = ? AND node_key = 'Build'
      `).get(plan.planId) as { count: number }).count,
      destinationInputs: (database.prepare(`
        SELECT count(*) AS count FROM execution_input_bindings
        WHERE plan_id = ? AND destination_run_id = ? AND gate_operation_id = ?
      `).get(plan.planId, consumeRun.runId, integrated.gateOperationId) as { count: number }).count,
      foreignKeys: database.pragma("foreign_key_check") as unknown[]
    }));
    assert.deepEqual(evidence, {
      dispatches: 2,
      completedRuns: 2,
      results: 2,
      passedVerifications: 2,
      succeededIntegrations: 1,
      integratedMaterializations: 1,
      destinationInputs: 1,
      foreignKeys: []
    });
    assert.equal(
      createHash("sha256").update(await readFile(path.join(sourceA, "src/dependency.ts"))).digest("hex"),
      createHash("sha256").update("export const state = 'old';\n").digest("hex")
    );
  } catch (error) {
    const logs = processHistory.map((handle, index) => [
      `Process ${index + 1}: pid=${String(handle.process.pid)} ` +
        `code=${String(handle.process.exitCode)} signal=${String(handle.process.signalCode)}`,
      `stdout:\n${handle.stdout}`,
      `stderr:\n${handle.stderr}`
    ].join("\n")).join("\n\n");
    throw new Error(`${String(error)}\nStage: ${stage}\n${logs}`, { cause: error });
  } finally {
    await Promise.allSettled([
      bridgeA?.stop(),
      bridgeB?.stop(),
      central?.stop()
    ]);
  }
});
