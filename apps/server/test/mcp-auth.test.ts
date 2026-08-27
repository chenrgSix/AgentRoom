import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

const now = "2026-08-22T10:00:00.000Z";

test("Remote MCP authenticates a manual Agent bearer token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-mcp-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now
  });
  try {
    const denied = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" }
        }
      }
    });
    assert.equal(denied.statusCode, 401);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    const webToken = bootstrap.json().session.token as string;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: `Bearer ${webToken}` },
      payload: { name: "Core Team" }
    });
    const teamId = team.json().team.teamId as string;
    const ownerMemberId = team.json().owner.memberId as string;
    const room = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: { name: "general" }
    });
    const roomId = room.json().roomId as string;
    const manual = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/manual-agents`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: { name: "Codex Alice", role: "Builder" }
    });
    assert.equal(manual.statusCode, 200);
    assert.equal(manual.json().agent.integrationMode, "manual");
    const manualAgentId = manual.json().agent.agentId as string;
    const mcpToken = manual.json().credential.token as string;
    const otherManual = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/manual-agents`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: { name: "Other Manual Agent", role: "Reviewer" }
    });
    assert.equal(otherManual.statusCode, 200);
    const otherAgentId = otherManual.json().agent.agentId as string;

    const initialized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" }
        }
      }
    });
    assert.equal(initialized.statusCode, 200);
    assert.equal(initialized.json().result.serverInfo.name, "agent-room");

    const whoami = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "team.whoami", arguments: {} }
      }
    });
    assert.equal(whoami.statusCode, 200);
    assert.equal(whoami.json().result.structuredContent.teamId, teamId);

    const sent = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "team.send_message",
          arguments: { roomId, content: "MCP Agent online" }
        }
      }
    });
    assert.equal(sent.statusCode, 200);
    const sentMessageId = sent.json().result.structuredContent.message.messageId as string;
    assert.equal(sent.json().result.structuredContent.message.senderType, "agent");

    const replied = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "team.reply",
          arguments: {
            roomId,
            parentMessageId: sentMessageId,
            content: "Reply from MCP"
          }
        }
      }
    });
    assert.equal(replied.statusCode, 200);
    assert.equal(
      replied.json().result.structuredContent.message.parentMessageId,
      sentMessageId
    );

    const context = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "team.get_context",
          arguments: { roomId, limit: 20 }
        }
      }
    });
    assert.equal(context.statusCode, 200);
    assert.equal(context.json().result.structuredContent.messages.length, 2);

    const waitStart = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "team.wait",
          arguments: { roomId, timeoutMs: 100 }
        }
      }
    });
    const cursor = waitStart.json().result.structuredContent.cursor as string;
    const waiting = app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "team.wait",
          arguments: { roomId, cursor, timeoutMs: 1_000 }
        }
      }
    });
    const webMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: { content: "Wake waiting MCP participant" }
    });
    assert.equal(webMessage.statusCode, 200);
    const resumed = await waiting;
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().result.structuredContent.timedOut, false);
    assert.equal(resumed.json().result.structuredContent.events.length, 1);

    const timedOut = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "team.wait",
          arguments: {
            roomId,
            cursor: resumed.json().result.structuredContent.cursor,
            timeoutMs: 100
          }
        }
      }
    });
    assert.equal(timedOut.json().result.structuredContent.timedOut, true);

    const mentioned = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: {
        content: "Complete this through MCP",
        mentionAgentId: manualAgentId
      }
    });
    assert.equal(mentioned.statusCode, 200);

    const mentions = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "team.get_mentions", arguments: {} }
      }
    });
    const assignedRun = mentions.json().result.structuredContent.mentions[0].run;
    assert.equal(assignedRun.targetAgentId, manualAgentId);
    assert.equal(assignedRun.state, "queued");

    const completed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "team.complete_run",
          arguments: { runId: assignedRun.runId, content: "Completed through MCP." }
        }
      }
    });
    assert.equal(completed.json().result.structuredContent.run.state, "completed");
    const reportedArtifact = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "team.report_task_artifact",
          arguments: {
            taskId: assignedRun.taskId,
            type: "commit",
            workspaceRef: "workspace_manual_agent",
            repository: "agent-room/network",
            commitSha: "21f9e8c",
            title: "Completed MCP change",
            summary: "Manual Agent reports a commit for independent verification.",
            sourceRunId: assignedRun.runId
          }
        }
      }
    });
    assert.equal(reportedArtifact.statusCode, 200);
    assert.equal(
      reportedArtifact.json().result.structuredContent.artifact.createdByAgentId,
      manualAgentId
    );
    const sourceArtifactId = reportedArtifact.json().result.structuredContent
      .artifact.artifactId as string;
    const verifiedArtifact = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "team.report_task_artifact",
          arguments: {
            taskId: assignedRun.taskId,
            type: "test_result",
            workspaceRef: "workspace_manual_agent",
            title: "MCP verification result",
            summary: "Manual Agent verifies its earlier canonical evidence.",
            sourceRunId: assignedRun.runId,
            relations: [{
              type: "verifies",
              targetArtifactId: sourceArtifactId
            }]
          }
        }
      }
    });
    assert.equal(verifiedArtifact.statusCode, 200);
    assert.equal(
      verifiedArtifact.json().result.structuredContent.artifact.relations[0]
        .targetArtifactId,
      sourceArtifactId
    );
    const listedArtifacts = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "team.list_task_artifacts",
          arguments: { taskId: assignedRun.taskId }
        }
      }
    });
    assert.equal(listedArtifacts.statusCode, 200);
    assert.equal(listedArtifacts.json().result.structuredContent.revision, 2);
    assert.equal(
      listedArtifacts.json().result.structuredContent.artifacts[0].sourceRunId,
      assignedRun.runId
    );
    assert.equal(
      listedArtifacts.json().result.structuredContent.artifacts[0].relations[0]
        .type,
      "verifies"
    );
    const foreignTask = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: {
        title: "Other Agent work",
        goal: "Remain outside the authenticated manual Agent scope.",
        assignments: [{ agentId: otherAgentId, role: "primary" }]
      }
    });
    assert.equal(foreignTask.statusCode, 200, foreignTask.body);

    const assignedTasks = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: {
          name: "team.list_assigned_tasks",
          arguments: { limit: 100 }
        }
      }
    });
    assert.equal(assignedTasks.statusCode, 200);
    const assignedTaskIds = assignedTasks.json().result.structuredContent.tasks
      .map((task: { taskId: string }) => task.taskId) as string[];
    assert.equal(assignedTaskIds.includes(assignedRun.taskId), true);
    assert.equal(assignedTaskIds.includes(foreignTask.json().taskId), false);

    const taskRead = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 15,
        method: "tools/call",
        params: {
          name: "team.get_task",
          arguments: { taskId: assignedRun.taskId }
        }
      }
    });
    assert.equal(taskRead.statusCode, 200);
    const taskProjection = taskRead.json().result.structuredContent.task;
    assert.equal(taskProjection.taskId, assignedRun.taskId);

    const deniedTask = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 16,
        method: "tools/call",
        params: {
          name: "team.get_task",
          arguments: { taskId: foreignTask.json().taskId }
        }
      }
    });
    assert.equal(deniedTask.statusCode, 200);
    assert.equal(deniedTask.json().result.isError, true);

    const proposal = {
      operationId: "op_manual_mcp_result_0001",
      taskId: assignedRun.taskId,
      definitionRevision: taskProjection.definitionRevision,
      criteriaRevision: taskProjection.criteriaRevision,
      proposedAtTaskRevision: taskProjection.taskRevision,
      supersedesResultId: null,
      outcome: "satisfied",
      summary: "The manual Agent explicitly submits its verified work.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_manual_artifact_0001",
        kind: "artifact",
        artifactId: sourceArtifactId
      }, {
        evidenceRefId: "evidence_manual_event_0001",
        kind: "run_event",
        runId: assignedRun.runId,
        sequence: 3
      }],
      criterionClaims: []
    };
    const proposedResult = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 17,
        method: "tools/call",
        params: {
          name: "team.propose_result",
          arguments: { runId: assignedRun.runId, proposal }
        }
      }
    });
    assert.equal(proposedResult.statusCode, 200, proposedResult.body);
    assert.equal(proposedResult.json().result.isError, undefined);
    const resultProjection = proposedResult.json().result.structuredContent.result;
    assert.deepEqual(resultProjection.proposedBy, {
      kind: "manual_agent",
      agentId: manualAgentId,
      runId: assignedRun.runId
    });
    const proposalReplay = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 18,
        method: "tools/call",
        params: {
          name: "team.propose_result",
          arguments: { runId: assignedRun.runId, proposal }
        }
      }
    });
    assert.deepEqual(
      proposalReplay.json().result.structuredContent.result,
      resultProjection
    );

    const taskResults = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 19,
        method: "tools/call",
        params: {
          name: "team.list_task_results",
          arguments: { taskId: assignedRun.taskId }
        }
      }
    });
    assert.equal(taskResults.statusCode, 200);
    assert.equal(
      taskResults.json().result.structuredContent.results[0].resultId,
      resultProjection.resultId
    );

    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 20,
        method: "tools/list",
        params: {}
      }
    });
    const toolNames = tools.json().result.tools.map(
      (tool: { name: string }) => tool.name
    ) as string[];
    assert.equal(toolNames.includes("team.propose_result"), true);
    assert.equal(toolNames.some((name) => [
      "team.review_result",
      "team.complete_task",
      "team.reassign_task",
      "team.acknowledge_outcome",
      "team.extend_budget"
    ].includes(name)), false);
    const removedAgent = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomId}/participants`,
      headers: { authorization: `Bearer ${webToken}` },
      payload: {
        memberIds: [ownerMemberId],
        agentIds: [otherAgentId]
      }
    });
    assert.equal(removedAgent.statusCode, 200, removedAgent.body);
    const lostRoomAccess = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "team.get_task",
          arguments: { taskId: assignedRun.taskId }
        }
      }
    });
    assert.equal(lostRoomAccess.statusCode, 200);
    assert.equal(lostRoomAccess.json().result.isError, true);
    const timeline = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/messages?limit=100`,
      headers: { authorization: `Bearer ${webToken}` }
    });
    assert.equal(
      timeline.json().items.at(-1).content,
      "Completed through MCP."
    );
  } finally {
    await app.close();
  }
});
