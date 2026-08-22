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
    const mcpToken = manual.json().credential.token as string;

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
  } finally {
    await app.close();
  }
});
