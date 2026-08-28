import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from "node:http";
import { connect as connectTcp } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../../apps/server/src/app.js";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const contentPathPattern =
  /^\/api\/bridge\/runs\/run_[^/]+\/artifacts\/artifact_[^/]+\/contents\/content_[^/]+$/u;

interface FaultState {
  corruptNextContent: boolean;
  corruptedContentResponses: number;
  dropNextBindResponse: boolean;
  droppedBindResponses: number;
  holdSecondChunk: boolean;
  heldSecondChunks: number;
  heldResponses: Set<ServerResponse>;
}

interface BridgeHandle {
  process: ChildProcess;
  stdout: string;
  stderr: string;
}

interface AgentView {
  agentId: string;
  name: string;
  presence: string;
}

interface RunView {
  runId: string;
  state: string;
}

interface ArtifactView {
  artifactId: string;
  artifactRevision: number;
  contentId: string | null;
  contentSha256: string | null;
  contentSizeBytes: number | null;
  path: string | null;
  relations: Array<{
    sourceArtifactId: string;
    targetArtifactId: string;
    type: string;
  }>;
  sourceRunId: string | null;
  title: string;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Artifact handoff state");
}

async function stopBridge(handle: BridgeHandle | undefined): Promise<void> {
  if (!handle || handle.process.exitCode !== null) return;
  handle.process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => handle.process.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ]);
  if (handle.process.exitCode === null) {
    handle.process.kill("SIGKILL");
    await new Promise<void>((resolve) => handle.process.once("exit", () => resolve()));
  }
}

function startBridge(binary: string, configPath: string): BridgeHandle {
  const handle: BridgeHandle = {
    process: spawn(binary, ["run", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"]
    }),
    stdout: "",
    stderr: ""
  };
  handle.process.stdout?.on("data", (source: Buffer) => {
    handle.stdout = (handle.stdout + source.toString()).slice(-4_000);
  });
  handle.process.stderr?.on("data", (source: Buffer) => {
    handle.stderr = (handle.stderr + source.toString()).slice(-4_000);
  });
  return handle;
}

function copyUpstreamResponse(
  upstream: IncomingMessage,
  downstream: ServerResponse
): void {
  downstream.statusCode = upstream.statusCode ?? 502;
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value !== undefined) downstream.setHeader(name, value);
  }
}

function createFaultProxy(upstreamPort: number, faults: FaultState): HttpServer {
  const proxy = createHttpServer((incoming, downstream) => {
    const requestPath = incoming.url ?? "/";
    const isContent = incoming.method === "GET" && contentPathPattern.test(requestPath);
    const range = Array.isArray(incoming.headers.range)
      ? incoming.headers.range[0]
      : incoming.headers.range;
    if (
      isContent && faults.holdSecondChunk &&
      range?.startsWith("bytes=262144-")
    ) {
      faults.heldSecondChunks++;
      faults.heldResponses.add(downstream);
      incoming.resume();
      downstream.once("close", () => faults.heldResponses.delete(downstream));
      return;
    }

    const corruptThisResponse = isContent && faults.corruptNextContent;
    if (corruptThisResponse) faults.corruptNextContent = false;
    const dropThisResponse =
      incoming.method === "POST" && requestPath.endsWith("/bind") &&
      faults.dropNextBindResponse;
    if (dropThisResponse) faults.dropNextBindResponse = false;

    const upstream = httpRequest({
      host: "127.0.0.1",
      port: upstreamPort,
      method: incoming.method,
      path: requestPath,
      headers: incoming.headers
    }, (response) => {
      if (dropThisResponse) {
        response.resume();
        response.once("end", () => {
          faults.droppedBindResponses++;
          downstream.socket?.destroy();
        });
        return;
      }
      if (corruptThisResponse) {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const body = Buffer.concat(chunks);
          assert.ok(body.length > 0, "fault proxy received an empty content range");
          body[Math.floor(body.length / 2)] ^= 0x01;
          faults.corruptedContentResponses++;
          copyUpstreamResponse(response, downstream);
          downstream.end(body);
        });
        return;
      }
      copyUpstreamResponse(response, downstream);
      response.pipe(downstream);
    });
    upstream.once("error", () => {
      if (!downstream.destroyed) {
        downstream.statusCode = 502;
        downstream.end("upstream unavailable");
      }
    });
    incoming.pipe(upstream);
  });

  proxy.on("upgrade", (request, socket, head) => {
    const upstream = connectTcp(upstreamPort, "127.0.0.1", () => {
      upstream.write(
        `${request.method ?? "GET"} ${request.url ?? "/"} ` +
        `HTTP/${request.httpVersion}\r\n`
      );
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        upstream.write(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}\r\n`);
      }
      upstream.write("\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
  });
  return proxy;
}

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind TCP");
  return address.port;
}

async function closeProxy(server: HttpServer, faults: FaultState): Promise<void> {
  for (const response of faults.heldResponses) response.destroy();
  faults.heldResponses.clear();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function artifactId(stdout: string): string {
  const matched = /published Artifact (artifact_[A-Za-z0-9_-]+)/u.exec(stdout);
  assert.ok(matched, `Bridge publication output omitted Artifact identity: ${stdout}`);
  return matched[1];
}

test("two Bridges converge an Artifact-to-Artifact handoff across recovery cuts", {
  timeout: 120_000
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-artifact-e2e-"));
  const workspaceA = path.join(directory, "workspace-a");
  const workspaceB = path.join(directory, "workspace-b");
  const dataA = path.join(directory, "data-a");
  const dataB = path.join(directory, "data-b");
  await Promise.all([
    mkdir(workspaceA, { recursive: true }),
    mkdir(workspaceB, { recursive: true })
  ]);
  const bridgeServerToken = "artifact-e2e-central-token-12345678901234567890";
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    bridgeServerToken
  });
  const faults: FaultState = {
    corruptNextContent: false,
    corruptedContentResponses: 0,
    dropNextBindResponse: false,
    droppedBindResponses: 0,
    holdSecondChunk: false,
    heldSecondChunks: 0,
    heldResponses: new Set()
  };
  let proxy: HttpServer | undefined;
  let bridgeA: BridgeHandle | undefined;
  let bridgeB: BridgeHandle | undefined;
  const bridgeBHistory: BridgeHandle[] = [];
  let stage = "setup";

  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const serverAddress = app.server.address();
    if (!serverAddress || typeof serverAddress === "string") {
      throw new Error("Server did not bind TCP");
    }
    proxy = createFaultProxy(serverAddress.port, faults);
    const proxyPort = await listen(proxy);
    const serverUrl = `http://127.0.0.1:${proxyPort}`;

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Artifact Owner" }
    });
    const authorization = {
      authorization: `Bearer ${bootstrap.json().session.token as string}`
    };
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: authorization,
      payload: { name: "Artifact Recovery Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const roomResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: authorization,
      payload: { name: "handoff" }
    });
    const roomId = roomResponse.json().roomId as string;
    const taskResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/tasks`,
      headers: authorization,
      payload: {
        title: "Verified Artifact handoff",
        goal: "Bridge A publishes source evidence and Bridge B verifies a derived result."
      }
    });
    assert.equal(taskResponse.statusCode, 200, taskResponse.body);
    const taskId = taskResponse.json().taskId as string;

    const bridgeBinary = path.join(directory, "convenewire-bridge");
    const goBinary = process.env.CONVENE_WIRE_GO_BIN ?? "go";
    await execFileAsync(goBinary, ["build", "-o", bridgeBinary, "./cmd/convenewire-bridge"], {
      cwd: path.join(repositoryRoot, "bridge")
    });

    const sourceBytes = Buffer.from([
      "diff --git a/source.txt b/source.txt",
      "--- a/source.txt",
      "+++ b/source.txt",
      ...Array.from(
        { length: 6_000 },
        (_, index) => `+verified source line ${index.toString().padStart(4, "0")} ` +
          "0123456789abcdef0123456789abcdef"
      )
    ].join("\n") + "\n", "utf8");
    assert.ok(sourceBytes.length > 256 << 10);
    assert.ok(sourceBytes.length < 4 << 20);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    await writeFile(path.join(workspaceA, "source.patch"), sourceBytes);

    const derivedPath = path.join(workspaceB, "derived.json");
    const runtimeMarker = path.join(workspaceB, "runtime-consumed.json");
    const consumerHelper = path.join(directory, "consume-artifact.mjs");
    await writeFile(consumerHelper, [
      "import { createHash } from 'node:crypto';",
      "import { readFile, writeFile } from 'node:fs/promises';",
      "let prompt = '';",
      "for await (const chunk of process.stdin) prompt += chunk;",
      "const line = prompt.split('\\n').find((value) => value.startsWith('- alias=artifact://'));",
      "const matched = line && /- alias=([^;]+); readPath=(\"(?:[^\"\\\\]|\\\\.)*\");/.exec(line);",
      "if (!matched) process.exit(20);",
      "const alias = matched[1];",
      "const readPath = JSON.parse(matched[2]);",
      "const bytes = await readFile(readPath);",
      "const digest = createHash('sha256').update(bytes).digest('hex');",
      `if (digest !== ${JSON.stringify(sourceSha256)}) process.exit(21);`,
      "const derived = JSON.stringify({",
      "  kind: 'verified_handoff', sourceAlias: alias, sourceSha256: digest,",
      "  sourceSizeBytes: bytes.length",
      "}, null, 2) + '\\n';",
      `await writeFile(${JSON.stringify(derivedPath)}, derived);`,
      `await writeFile(${JSON.stringify(runtimeMarker)}, JSON.stringify({ alias, readPath, digest }) + '\\n');`,
      "process.stdout.write(`consumed ${readPath}`);",
      "await new Promise((resolve) => setTimeout(resolve, 12_000));"
    ].join("\n"));

    const configA = path.join(directory, "bridge-a.json");
    const configB = path.join(directory, "bridge-b.json");
    await writeFile(configA, JSON.stringify({
      serverUrl,
      serverToken: bridgeServerToken,
      deviceName: "Source Bridge A",
      dataDir: dataA,
      agents: [{
        name: "Source Agent A",
        role: "Artifact producer",
        adapter: "generic",
        command: ["/bin/sh", "-c", "sleep 60"],
        workspace: workspaceA,
        envAllowlist: []
      }]
    }, null, 2));
    await writeFile(configB, JSON.stringify({
      serverUrl,
      serverToken: bridgeServerToken,
      deviceName: "Consumer Bridge B",
      dataDir: dataB,
      agents: [{
        name: "Consumer Agent B",
        role: "Artifact verifier",
        adapter: "generic",
        command: [process.execPath, consumerHelper],
        workspace: workspaceB,
        envAllowlist: []
      }]
    }, null, 2));

    for (const [deviceName, configPath] of [
      ["Source Bridge A", configA],
      ["Consumer Bridge B", configB]
    ] as const) {
      const invitation = await app.inject({
        method: "POST",
        url: `/api/teams/${teamId}/bridge-invites`,
        headers: authorization,
        payload: { deviceName }
      });
      assert.equal(invitation.statusCode, 200, invitation.body);
      await execFileAsync(bridgeBinary, [
        "pair", "--config", configPath, "--code", invitation.json().code as string
      ]);
    }

    bridgeA = startBridge(bridgeBinary, configA);
    bridgeB = startBridge(bridgeBinary, configB);
    bridgeBHistory.push(bridgeB);
    stage = "wait for both managed Agents";
    const agents = await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/agents`,
        headers: authorization
      });
      const values = response.json() as AgentView[];
      const source = values.find((agent) =>
        agent.name === "Source Agent A" && agent.presence === "ready"
      );
      const consumer = values.find((agent) =>
        agent.name === "Consumer Agent B" && agent.presence === "ready"
      );
      return source && consumer ? { source, consumer } : undefined;
    });
    const assignedTask = await app.inject({
      method: "PUT",
      url: `/api/tasks/${taskId}/definition`,
      headers: authorization,
      payload: {
        operationId: "op_artifact_handoff_assign_0001",
        expectedTaskRevision: 1,
        title: taskResponse.json().title,
        goal: taskResponse.json().goal,
        ownerMemberId: taskResponse.json().ownerMemberId,
        completionPolicy: taskResponse.json().completionPolicy,
        priority: taskResponse.json().priority,
        dueAt: taskResponse.json().dueAt,
        criteria: [],
        assignments: [
          { agentId: agents.source.agentId, role: "primary" },
          { agentId: agents.consumer.agentId, role: "contributor" }
        ],
        budgetPolicy: taskResponse.json().budgetPolicy
      }
    });
    assert.equal(assignedTask.statusCode, 200, assignedTask.body);
    const activatedTask = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/control`,
      headers: authorization,
      payload: {
        operationId: "op_artifact_handoff_activate_0001",
        expectedTaskRevision: 2,
        lifecycleState: "active"
      }
    });
    assert.equal(activatedTask.statusCode, 200, activatedTask.body);

    stage = "take Bridge B offline";
    await stopBridge(bridgeB);
    bridgeB = undefined;

    const sourceMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        taskId,
        content: "Publish Artifact A for an offline consumer.",
        mentionAgentId: agents.source.agentId
      }
    });
    assert.equal(sourceMessage.statusCode, 200, sourceMessage.body);
    const sourceRunId = sourceMessage.json().runs[0].runId as string;
    stage = "wait for source Runtime";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as RunView[]).find(({ runId }) => runId === sourceRunId);
      return run?.state === "working" ? run : undefined;
    });

    stage = "publish Artifact A with a lost bind response";
    faults.dropNextBindResponse = true;
    const publishAArguments = [
      "artifact", "publish",
      "--config", configA,
      "--agent", "Source Agent A",
      "--run-id", sourceRunId,
      "--type", "patch",
      "--file", "source.patch",
      "--title", "Artifact A",
      "--summary", "Verified source snapshot from Bridge A."
    ];
    const publishedA = await execFileAsync(bridgeBinary, publishAArguments);
    const artifactAId = artifactId(publishedA.stdout);
    assert.equal(faults.droppedBindResponses, 1);
    const duplicateA = await execFileAsync(bridgeBinary, publishAArguments);
    assert.equal(artifactId(duplicateA.stdout), artifactAId);

    let artifactsResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/artifacts`,
      headers: authorization
    });
    let artifactPage = artifactsResponse.json() as {
      revision: number;
      artifacts: ArtifactView[];
    };
    assert.equal(artifactPage.revision, 1);
    assert.equal(artifactPage.artifacts.length, 1);
    const artifactA = artifactPage.artifacts[0];
    assert.equal(artifactA.artifactId, artifactAId);
    assert.equal(artifactA.contentSha256, sourceSha256);
    assert.equal(artifactA.contentSizeBytes, sourceBytes.length);
    assert.equal(artifactA.sourceRunId, sourceRunId);
    assert.ok(artifactA.contentId);

    const cancelSource = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/cancel`,
      headers: authorization,
      payload: { reason: "Artifact A is published" }
    });
    assert.equal(cancelSource.statusCode, 200, cancelSource.body);

    stage = "queue consumer while Bridge B is offline";
    const corruptMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        taskId,
        content: "Reject any corrupted Artifact A bytes.",
        mentionAgentId: agents.consumer.agentId
      }
    });
    assert.equal(corruptMessage.statusCode, 200, corruptMessage.body);
    const corruptRunId = corruptMessage.json().runs[0].runId as string;
    const queuedRun = (corruptMessage.json().runs as RunView[]).find(
      ({ runId }) => runId === corruptRunId
    );
    assert.equal(queuedRun?.state, "queued");

    faults.corruptNextContent = true;
    bridgeB = startBridge(bridgeBinary, configB);
    bridgeBHistory.push(bridgeB);
    stage = "fail closed on corrupted staged bytes";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as RunView[]).find(({ runId }) => runId === corruptRunId);
      return run?.state === "failed" ? run : undefined;
    });
    assert.equal(faults.corruptedContentResponses, 1);
    await assert.rejects(access(runtimeMarker));
    const corruptEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${corruptRunId}/events?after=0`,
      headers: authorization
    });
    assert.ok((corruptEvents.json() as Array<{
      event: { error?: { code?: string } };
    }>).some(({ event }) =>
      event.error?.code === "ARTIFACT_MATERIALIZATION_FAILED"
    ));
    const corruptPartial = path.join(
      dataB,
      "materializations",
      corruptRunId,
      artifactAId,
      `.${artifactA.contentId as string}.part`
    );
    await assert.rejects(access(corruptPartial));

    stage = "queue a resumable consumer Run while Bridge B is offline";
    await stopBridge(bridgeB);
    bridgeB = undefined;
    const consumeMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        taskId,
        content: "Consume Artifact A and publish a verified Artifact B.",
        mentionAgentId: agents.consumer.agentId
      }
    });
    assert.equal(consumeMessage.statusCode, 200, consumeMessage.body);
    const consumeRunId = consumeMessage.json().runs[0].runId as string;
    assert.equal(consumeMessage.json().runs[0].state, "queued");

    faults.holdSecondChunk = true;
    bridgeB = startBridge(bridgeBinary, configB);
    bridgeBHistory.push(bridgeB);
    const resumablePartial = path.join(
      dataB,
      "materializations",
      consumeRunId,
      artifactAId,
      `.${artifactA.contentId as string}.part`
    );
    stage = "interrupt Bridge B after the first durable range";
    await waitFor(async () => {
      try {
        const info = await stat(resumablePartial);
        return info.size === 256 << 10 && faults.heldSecondChunks === 1
          ? info
          : undefined;
      } catch {
        return undefined;
      }
    });
    await stopBridge(bridgeB);
    bridgeB = undefined;
    faults.holdSecondChunk = false;
    for (const response of faults.heldResponses) response.destroy();
    faults.heldResponses.clear();

    stage = "restart Bridge B and resume the same materialization";
    bridgeB = startBridge(bridgeBinary, configB);
    bridgeBHistory.push(bridgeB);
    const consumed = await waitFor(async () => {
      try {
        return JSON.parse(await readFile(runtimeMarker, "utf8")) as {
          alias: string;
          digest: string;
          readPath: string;
        };
      } catch {
        return undefined;
      }
    });
    assert.equal(consumed.alias, `artifact://${artifactAId}/source.patch`);
    assert.equal(consumed.digest, sourceSha256);
    const resolvedDataB = await realpath(dataB);
    const resolvedWorkspaceB = await realpath(workspaceB);
    assert.ok(consumed.readPath.startsWith(
      path.join(resolvedDataB, "materializations") + path.sep
    ));
    assert.equal(consumed.readPath.startsWith(resolvedWorkspaceB + path.sep), false);
    assert.deepEqual(await readFile(consumed.readPath), sourceBytes);
    const stagedMode = (await stat(consumed.readPath)).mode & 0o777;
    assert.equal(stagedMode, 0o400);

    const activeConsumerRun = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as RunView[]).find(({ runId }) => runId === consumeRunId);
      return run?.state === "working" ? run : undefined;
    });
    assert.equal(activeConsumerRun.runId, consumeRunId);

    stage = "publish linked Artifact B and deduplicate its retry";
    const publishBArguments = [
      "artifact", "publish",
      "--config", configB,
      "--agent", "Consumer Agent B",
      "--run-id", consumeRunId,
      "--type", "test_result",
      "--file", "derived.json",
      "--title", "Artifact B",
      "--summary", "Bridge B verified the exact staged bytes from Artifact A.",
      "--verifies", artifactAId
    ];
    const publishedB = await execFileAsync(bridgeBinary, publishBArguments);
    const artifactBId = artifactId(publishedB.stdout);
    const duplicateB = await execFileAsync(bridgeBinary, publishBArguments);
    assert.equal(artifactId(duplicateB.stdout), artifactBId);

    const derivedBytes = await readFile(derivedPath);
    const derivedSha256 = createHash("sha256").update(derivedBytes).digest("hex");
    artifactsResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/artifacts`,
      headers: authorization
    });
    artifactPage = artifactsResponse.json() as {
      revision: number;
      artifacts: ArtifactView[];
    };
    assert.equal(artifactPage.revision, 2);
    assert.equal(artifactPage.artifacts.length, 2);
    const artifactB = artifactPage.artifacts.find(({ artifactId: id }) => id === artifactBId);
    assert.ok(artifactB);
    assert.equal(artifactB.artifactRevision, 2);
    assert.equal(artifactB.contentSha256, derivedSha256);
    assert.equal(artifactB.sourceRunId, consumeRunId);
    assert.deepEqual(artifactB.relations.map((relation) => ({
      sourceArtifactId: relation.sourceArtifactId,
      targetArtifactId: relation.targetArtifactId,
      type: relation.type
    })), [{
      sourceArtifactId: artifactBId,
      targetArtifactId: artifactAId,
      type: "verifies"
    }]);

    stage = "complete the consumer Runtime with local-path redaction";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as RunView[]).find(({ runId }) => runId === consumeRunId);
      return run?.state === "completed" ? run : undefined;
    }, 30_000);
    const timeline = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/messages?limit=100`,
      headers: authorization
    });
    const messages = timeline.json().items as Array<{ content: string }>;
    assert.ok(messages.some(({ content }) =>
      content === `consumed artifact://${artifactAId}/source.patch`
    ));
    assert.equal(messages.some(({ content }) => content.includes(dataB)), false);
    assert.equal(publishedA.stdout.includes(workspaceA), false);
    assert.equal(publishedB.stdout.includes(workspaceB), false);
    assert.equal(faults.heldSecondChunks, 1);
  } catch (error) {
    const bridgeLogs = [bridgeA, ...bridgeBHistory].map((handle, index) =>
      `Bridge ${index + 1} exit: code=${String(handle?.process.exitCode)} ` +
      `signal=${String(handle?.process.signalCode)}\nstdout:\n${handle?.stdout ?? ""}` +
      `\nstderr:\n${handle?.stderr ?? ""}`
    ).join("\n\n");
    throw new Error(`${String(error)}\nStage: ${stage}\n${bridgeLogs}`);
  } finally {
    await stopBridge(bridgeA);
    await stopBridge(bridgeB);
    if (proxy) await closeProxy(proxy, faults);
    await app.close();
  }
});
