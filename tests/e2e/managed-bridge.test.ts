import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../../apps/server/src/app.js";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for cross-process state");
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => process.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ]);
}

async function verifyManagedBridge(shareReasoningSummaries: boolean): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-e2e-"));
  const bridgeServerToken = "managed-e2e-central-token-12345678901234567890";
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    bridgeServerToken
  });
  let bridgeProcess: ChildProcess | undefined;
  let stage = "setup";
  let bridgeStdout = "";
  let bridgeStderr = "";
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind TCP");
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const bootstrap = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { displayName: "Alice" }
    });
    const webToken = bootstrap.json().session.token as string;
    const authorization = { authorization: `Bearer ${webToken}` };
    const teamResponse = await app.inject({
      method: "POST", url: "/api/teams", headers: authorization,
      payload: { name: "Managed Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const roomResponse = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/rooms`, headers: authorization,
      payload: { name: "general" }
    });
    const roomId = roomResponse.json().roomId as string;
    const defaultTasksResponse = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/tasks`,
      headers: authorization
    });
    assert.equal(defaultTasksResponse.statusCode, 200);
    const defaultTask = defaultTasksResponse.json().find(
      (task: { isDefault: boolean }) => task.isDefault
    );
    assert.ok(defaultTask);
    const inviteResponse = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/bridge-invites`, headers: authorization,
      payload: { deviceName: "Bob Bridge" }
    });
    const pairingCode = inviteResponse.json().code as string;

    const bridgeBinary = path.join(directory, "agentroom-bridge");
    const goBinary = process.env.AGENT_ROOM_GO_BIN ?? "go";
    await execFileAsync(goBinary, ["build", "-o", bridgeBinary, "./cmd/agentroom-bridge"], {
      cwd: path.join(repositoryRoot, "bridge")
    });
    const piReply = `PI STREAMING FINAL ${"RESULT ".repeat(14).trim()}`;
    const piReasoning = `Inspecting exact Agent routing ${"context ".repeat(12).trim()}`;
    const piHelperPath = path.join(directory, "pi-helper.mjs");
    await writeFile(piHelperPath, [
      `const reply = ${JSON.stringify(piReply)};`,
      "const sessionIndex = process.argv.indexOf('--session-id');",
      "const nameIndex = process.argv.indexOf('--name');",
      "if (sessionIndex < 0 || !/^[0-9a-f-]{36}$/.test(process.argv[sessionIndex + 1] ?? '') ||",
      "    nameIndex < 0 || !(process.argv[nameIndex + 1] ?? '').startsWith('AgentRoom · Pi Builder · ')) process.exit(2);",
      "const send = (event) => process.stdout.write(`${JSON.stringify(event)}\\n`);",
      "send({ type: 'message_start', message: { role: 'assistant', content: [] } });",
      `send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ${JSON.stringify(`${piReasoning} token=split`)} } });`,
      "send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '-secret-value-123456' } });",
      "send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'inspect_project' });",
      "send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'inspect_project' });",
      "send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } });",
      "setTimeout(() => {",
      "  send({ type: 'message_end', message: {",
      "    role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop'",
      "  } });",
      "}, 1200);"
    ].join("\n"));
    const artifactBytes = Buffer.from(
      "diff --git a/verified.txt b/verified.txt\n+cross-process artifact\n",
      "utf8"
    );
    await writeFile(path.join(directory, "verified.patch"), artifactBytes);
    const configPath = path.join(directory, "bridge.json");
    await writeFile(configPath, JSON.stringify({
      serverUrl,
      serverToken: bridgeServerToken,
      ...(shareReasoningSummaries ? { shareReasoningSummaries: true } : {}),
      deviceName: "Bob Bridge",
      dataDir: path.join(directory, "bridge-data"),
      agents: [{
        name: "Echo Builder",
        role: "Generic Runtime",
        adapter: "generic",
        command: ["/usr/bin/tr", "a-z", "A-Z"],
        workspace: directory,
        envAllowlist: []
      }, {
        name: "Pi Builder",
        role: "Streaming Runtime",
        adapter: "generic",
        runtimeKind: "pi",
        presetVersion: 3,
        command: [process.execPath, piHelperPath],
        workspace: directory,
        envAllowlist: []
      }, {
        name: "Slow Builder",
        role: "Cancelable Runtime",
        adapter: "generic",
        command: ["/bin/sh", "-c", "sleep 10"],
        workspace: directory,
        envAllowlist: []
      }]
    }, null, 2));
    await execFileAsync(bridgeBinary, ["pair", "--config", configPath, "--code", pairingCode]);
    bridgeProcess = spawn(bridgeBinary, ["run", "--config", configPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    bridgeProcess.stdout?.on("data", (source: Buffer) => {
      bridgeStdout = (bridgeStdout + source.toString()).slice(-2_000);
    });
    bridgeProcess.stderr?.on("data", (source: Buffer) => {
      bridgeStderr = (bridgeStderr + source.toString()).slice(-2_000);
    });

    stage = "wait for Echo Builder presence";
    const agent = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/agents`, headers: authorization
      });
      return (response.json() as Array<{
        agentId: string;
        name: string;
        integrationMode: string;
        presence: string;
      }>).find((candidate) =>
        candidate.name === "Echo Builder" && candidate.presence === "ready"
      );
    });
    const sent = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/messages`, headers: authorization,
      payload: { content: "Run through real Bridge", mentionAgentId: agent.agentId }
    });
    assert.equal(sent.statusCode, 200);
    const runId = sent.json().runs[0].runId as string;
    const traceId = sent.json().message.traceId as string;
    assert.equal(sent.json().runs[0].taskId, defaultTask.taskId);
    assert.equal(sent.json().runs[0].traceId, traceId);

    stage = "wait for Echo Builder completion";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === runId
      );
      return run?.state === "completed" ? run : undefined;
    });
    const timeline = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/messages?limit=100`, headers: authorization
    });
    const echoReply = timeline.json().items.at(-1);
    assert.match(echoReply.content, /OTHER ELIGIBLE AGENT NAMES: PI BUILDER; SLOW BUILDER/);
    assert.match(echoReply.content, /CURRENT REQUEST:\nRUN THROUGH REAL BRIDGE$/);
    assert.equal(echoReply.content.includes("@PI BUILDER"), false);
    assert.equal(echoReply.content.includes("@ALL"), false);
    assert.equal(echoReply.traceId, traceId);
    const traceResponse = await app.inject({
      method: "GET", url: `/api/traces/${traceId}`, headers: authorization
    });
    assert.equal(traceResponse.statusCode, 200);
    const traceEntries = traceResponse.json().entries as Array<{ kind: string }>;
    assert.deepEqual(
      new Set(traceEntries.map(({ kind }) => kind)),
      new Set(["message", "run", "delivery", "run_event"])
    );
    const outsider = await app.inject({
      method: "POST", url: "/api/bootstrap",
      payload: { displayName: "Mallory" }
    });
    const deniedTrace = await app.inject({
      method: "GET",
      url: `/api/traces/${traceId}`,
      headers: {
        authorization: `Bearer ${outsider.json().session.token as string}`
      }
    });
    assert.equal(deniedTrace.statusCode, 403);

    stage = "wait for Pi Builder presence";
    const piAgent = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/agents`, headers: authorization
      });
      return (response.json() as Array<{
        agentId: string;
        name: string;
        presence: string;
        capabilities: { supportsResume: boolean };
      }>).find((candidate) =>
        candidate.name === "Pi Builder" && candidate.presence === "ready"
      );
    });
    assert.equal(piAgent.capabilities.supportsResume, true);
    const piSent = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/messages`, headers: authorization,
      payload: { content: "Stream through real Bridge", mentionAgentId: piAgent.agentId }
    });
    assert.equal(piSent.statusCode, 200);
    const piRunId = piSent.json().runs[0].runId as string;
    stage = "wait for Pi Builder output before final reply";
    const previewEvents = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/runs/${piRunId}/events?after=0`, headers: authorization
      });
      const events = response.json() as Array<{
        sequence: number;
        event: { type: string; kind?: string; content?: string };
      }>;
      const output = events.find(({ event }) => event.type === "output");
      const activity = events.find(({ event }) => event.type === "activity");
      const reply = events.find(({ event }) => event.type === "reply");
      return output && activity && !reply ? events : undefined;
    });
    const preview = previewEvents.find(({ event }) => event.type === "output");
    assert.ok(preview);
    assert.ok(preview.event.content);
    assert.ok(piReply.startsWith(preview.event.content));
    const liveActivities = previewEvents.filter(({ event }) => event.type === "activity");
    assert.equal(liveActivities.some(({ event }) => event.kind === "reasoning"), shareReasoningSummaries);
    assert.ok(liveActivities.some(({ event }) => event.kind === "tool"));
    assert.equal(
      liveActivities.some(({ event }) => event.content?.includes("split-secret-value")),
      false
    );
    const timelineBeforeReply = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/messages?limit=100`, headers: authorization
    });
    assert.equal(
      timelineBeforeReply.json().items.some((item: { content: string }) => item.content === piReply),
      false
    );

    stage = "wait for Pi Builder completion";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === piRunId
      );
      return run?.state === "completed" ? run : undefined;
    });
    const completedEventsResponse = await app.inject({
      method: "GET", url: `/api/runs/${piRunId}/events?after=0`, headers: authorization
    });
    const completedEvents = completedEventsResponse.json() as Array<{
      sequence: number;
      event: { type: string; kind?: string; phase?: string; content?: string };
    }>;
    const outputEvent = completedEvents.find(({ event }) => event.type === "output");
    const replyEvent = completedEvents.find(({ event }) => event.type === "reply");
    assert.ok(outputEvent);
    assert.ok(replyEvent);
    assert.ok(outputEvent.sequence < replyEvent.sequence);
    assert.equal(replyEvent.event.content, piReply);
    assert.equal(completedEvents.some(({ event }) =>
      event.type === "activity" && event.kind === "reasoning" && event.phase === "completed"
    ), shareReasoningSummaries);
    if (!shareReasoningSummaries) {
      assert.equal(JSON.stringify(completedEvents).includes(piReasoning), false);
      assert.equal(completedEvents.some(({ event }) => event.kind === "reasoning"), false);
    }
    const resumedEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${piRunId}/events?after=${outputEvent.sequence}`,
      headers: authorization
    });
    assert.ok((resumedEvents.json() as Array<{ event: { type: string } }>).some(
      ({ event }) => event.type === "reply"
    ));
    const piTimeline = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/messages?limit=100`, headers: authorization
    });
    assert.equal(
      piTimeline.json().items.filter((item: { content: string }) => item.content === piReply).length,
      1
    );

    stage = "wait for Slow Builder presence";
    const slowAgent = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/agents`, headers: authorization
      });
      return (response.json() as Array<{
        agentId: string;
        name: string;
        presence: string;
      }>).find((candidate) =>
        candidate.name === "Slow Builder" && candidate.presence === "ready"
      );
    });
    const formalTaskResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/tasks`,
      headers: authorization,
      payload: {
        title: "Accept managed Runtime evidence",
        goal: "Complete only after a managed Result cites the verified Artifact.",
        lifecycleState: "ready",
        completionPolicy: "accepted_result_required",
        criteria: [{
          criterionKey: "criterion_managed_e2e_0001",
          description: "The managed Runtime publishes durable Artifact evidence.",
          required: true,
          ordinal: 1
        }],
        assignments: [{ agentId: slowAgent.agentId, role: "primary" }]
      }
    });
    assert.equal(formalTaskResponse.statusCode, 200, formalTaskResponse.body);
    const formalTaskId = formalTaskResponse.json().taskId as string;
    const activatedTaskResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${formalTaskId}/control`,
      headers: authorization,
      payload: {
        operationId: "op_managed_e2e_activate_0001",
        expectedTaskRevision: 1,
        lifecycleState: "active"
      }
    });
    assert.equal(activatedTaskResponse.statusCode, 200, activatedTaskResponse.body);
    const unassignedRoute = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        taskId: formalTaskId,
        content: "An unassigned Agent must not receive this Task.",
        mentionAgentId: agent.agentId
      }
    });
    assert.equal(unassignedRoute.statusCode, 400);
    assert.match(unassignedRoute.json().error.message, /not assigned/u);
    const slowSent = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/messages`, headers: authorization,
      payload: {
        taskId: formalTaskId,
        content: "Publish verified evidence and propose the bounded Result.",
        mentionAgentId: slowAgent.agentId
      }
    });
    assert.equal(slowSent.statusCode, 200, slowSent.body);
    const slowRunId = slowSent.json().runs[0].runId as string;
    stage = "wait for Slow Builder working state";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === slowRunId
      );
      return run?.state === "working" ? run : undefined;
    });
    stage = "publish verified Artifact through the Bridge CLI";
    const published = await execFileAsync(bridgeBinary, [
      "artifact", "publish",
      "--config", configPath,
      "--agent", "Slow Builder",
      "--run-id", slowRunId,
      "--type", "patch",
      "--file", "verified.patch",
      "--title", "Cross-process patch",
      "--summary", "Published while the assigned Run is active."
    ]);
    assert.match(published.stdout, /published Artifact artifact_/u);
    assert.equal(published.stdout.includes(directory), false);
    const slowTaskId = slowSent.json().runs[0].taskId as string;
    assert.equal(slowTaskId, formalTaskId);
    const artifactResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${slowTaskId}/artifacts`,
      headers: authorization
    });
    assert.equal(artifactResponse.statusCode, 200, artifactResponse.body);
    const contentArtifact = artifactResponse.json().artifacts.find(
      (artifact: { title: string }) => artifact.title === "Cross-process patch"
    );
    assert.ok(contentArtifact);
    assert.equal(contentArtifact.contentMode, "snapshot_blob");
    assert.equal(contentArtifact.path, "verified.patch");
    assert.equal(
      contentArtifact.contentSha256,
      createHash("sha256").update(artifactBytes).digest("hex")
    );
    const taskBeforeProposalResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${formalTaskId}`,
      headers: authorization
    });
    assert.equal(taskBeforeProposalResponse.statusCode, 200);
    const taskBeforeProposal = taskBeforeProposalResponse.json();
    const runEventsResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${slowRunId}/events?after=0`,
      headers: authorization
    });
    assert.equal(runEventsResponse.statusCode, 200);
    const sourceEvent = (runEventsResponse.json() as Array<{
      sequence: number;
      event: { type: string };
    }>).find(({ event }) => event.type === "status");
    assert.ok(sourceEvent, "managed Run omitted its persisted status evidence");
    const managedProposal = {
      operationId: "op_managed_e2e_result_0001",
      taskId: formalTaskId,
      definitionRevision: taskBeforeProposal.definitionRevision,
      criteriaRevision: taskBeforeProposal.criteriaRevision,
      proposedAtTaskRevision: taskBeforeProposal.taskRevision,
      supersedesResultId: null,
      outcome: "satisfied",
      summary: "The managed Runtime published the verified patch.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_managed_e2e_artifact_0001",
        kind: "artifact",
        artifactId: contentArtifact.artifactId
      }, {
        evidenceRefId: "evidence_managed_e2e_event_0001",
        kind: "run_event",
        runId: slowRunId,
        sequence: sourceEvent.sequence
      }],
      criterionClaims: [{
        criterionKey: "criterion_managed_e2e_0001",
        coverage: "satisfied",
        explanation: "The immutable patch Artifact is the required evidence.",
        evidenceRefIds: ["evidence_managed_e2e_artifact_0001"]
      }]
    };
    stage = "propose managed Result through the paired Bridge credential";
    const proposedResult = await execFileAsync(bridgeBinary, [
      "result", "propose",
      "--config", configPath,
      "--agent", "Slow Builder",
      "--run-id", slowRunId,
      "--proposal-json", JSON.stringify(managedProposal)
    ]);
    const resultMatch = /proposed Result (result_[A-Za-z0-9_-]+) version 1/u.exec(
      proposedResult.stdout
    );
    assert.ok(resultMatch, proposedResult.stdout);
    const resultId = resultMatch[1];
    const proposedReplay = await execFileAsync(bridgeBinary, [
      "result", "propose",
      "--config", configPath,
      "--agent", "Slow Builder",
      "--run-id", slowRunId,
      "--proposal-json", JSON.stringify(managedProposal)
    ]);
    assert.equal(proposedReplay.stdout, proposedResult.stdout);
    const taskResultsResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${formalTaskId}/results`,
      headers: authorization
    });
    assert.equal(taskResultsResponse.statusCode, 200);
    assert.equal(taskResultsResponse.json().length, 1);
    assert.deepEqual(taskResultsResponse.json()[0].proposedBy, {
      kind: "managed_agent",
      agentId: slowAgent.agentId,
      runId: slowRunId
    });
    assert.equal(taskResultsResponse.json()[0].proposal.sources[0].artifactId,
      contentArtifact.artifactId);
    const canceled = await app.inject({
      method: "POST", url: `/api/runs/${slowRunId}/cancel`, headers: authorization,
      payload: { reason: "E2E cancellation" }
    });
    assert.equal(canceled.statusCode, 200);
    stage = "wait for Slow Builder cancellation";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === slowRunId
      );
      return run?.state === "canceled" ? run : undefined;
    });
    const taskBeforeReviewResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${formalTaskId}`,
      headers: authorization
    });
    assert.equal(taskBeforeReviewResponse.statusCode, 200);
    const reviewCommand = {
      operationId: "op_managed_e2e_review_0001",
      decision: "accepted",
      expectedTaskRevision: taskBeforeReviewResponse.json().taskRevision,
      expectedReviewRevision: 0,
      reason: "The physical managed Runtime supplied the required evidence.",
      completeTask: true
    };
    stage = "accept and complete after simulated response loss";
    const accepted = await app.inject({
      method: "POST",
      url: `/api/results/${resultId}/review-decisions`,
      headers: authorization,
      payload: reviewCommand
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().completedTask, true);
    const acceptedReplay = await app.inject({
      method: "POST",
      url: `/api/results/${resultId}/review-decisions`,
      headers: authorization,
      payload: reviewCommand
    });
    assert.deepEqual(acceptedReplay.json(), accepted.json());
    const completedTaskResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${formalTaskId}`,
      headers: authorization
    });
    assert.equal(completedTaskResponse.statusCode, 200);
    assert.equal(completedTaskResponse.json().lifecycleState, "completed");
    assert.equal(completedTaskResponse.json().completionResultId, resultId);
    assert.equal(bridgeStdout.includes(bridgeServerToken), false);
    assert.equal(bridgeStderr.includes(bridgeServerToken), false);
  } catch (error) {
    throw new Error(
      `${String(error)}\nStage: ${stage}` +
      `\nBridge exit: code=${String(bridgeProcess?.exitCode)} signal=${String(bridgeProcess?.signalCode)}` +
      `\nBridge stdout:\n${bridgeStdout}\nBridge stderr:\n${bridgeStderr}`
    );
  } finally {
    if (bridgeProcess) await stopProcess(bridgeProcess);
    await app.close();
  }
}

for (const shareReasoningSummaries of [false, true]) {
  test(`Web Mention and managed Result complete through a paired Go Bridge with reasoning sharing ${shareReasoningSummaries ? "enabled" : "disabled by default"}`, {
    timeout: 60_000
  }, () => verifyManagedBridge(shareReasoningSummaries));
}
