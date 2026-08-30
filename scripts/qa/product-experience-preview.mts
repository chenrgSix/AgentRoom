import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createServerApp } from "../../apps/server/src/app.js";
import { seedProductExperience } from "./product-experience-seed.js";

// An explicit, loopback-only QA harness, never a production deployment command.
assert.equal(process.env.CONVENE_WIRE_PRODUCT_PREVIEW, "1", "Set CONVENE_WIRE_PRODUCT_PREVIEW=1 to run disposable QA servers");
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = path.join(repositoryRoot, "apps/web/dist");
assert.ok((await stat(path.join(webRoot, "index.html"))).isFile(), "Run npm run build first");
const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-product-preview-"));
const apps: FastifyInstance[] = [];
// This is an intentionally public, synthetic credential for this fixture only.
const ownerRecoveryToken = "qa-only-owner-recovery-0123456789abcdef";

function providerFrame(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

const hostedFetch = (async (_input, init) => {
  // Never forward requests. The fake key below exercises the visible failure path.
  if (new Headers(init?.headers).get("authorization") === "Bearer qa-invalid-key") {
    return new Response(JSON.stringify({ error: { message: "Synthetic invalid credential" } }), {
      status: 401, headers: { "content-type": "application/json" }
    });
  }
  const text = "已收到你的消息。这是隔离验收模型的回复：中央 Agent 通过 HTTP 参与当前 Room，没有安装客户端，也没有操作电脑。";
  const responseId = `resp_qa_${randomUUID().replaceAll("-", "")}`;
  const message = { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
  const source = [
    providerFrame("response.created", { response: { id: responseId, status: "in_progress" } }),
    providerFrame("response.output_item.added", { output_index: 0, item: { type: "message", role: "assistant", content: [] } }),
    providerFrame("response.content_part.added", { output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
    providerFrame("response.output_text.delta", { output_index: 0, content_index: 0, delta: text }),
    providerFrame("response.output_text.done", { output_index: 0, content_index: 0, text }),
    providerFrame("response.content_part.done", { output_index: 0, content_index: 0, part: { type: "output_text", text } }),
    providerFrame("response.output_item.done", { output_index: 0, item: message }),
    providerFrame("response.completed", { response: { id: responseId, status: "completed", output: [message] } })
  ].join("");
  return new Response(source, { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

async function reservePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function checked<T = Record<string, unknown>>(response: { statusCode: number; json(): T }, operation: string): T {
  assert.equal(response.statusCode, 200, `${operation} failed (${response.statusCode})`);
  return response.json();
}

async function cleanup(): Promise<void> {
  await Promise.all(apps.map((app) => app.close()));
  // Only the exact fresh directory created above belongs to this process.
  await rm(directory, { recursive: true, force: true });
}

try {
  const local = await createServerApp({ databasePath: path.join(directory, "local/server.sqlite"), webRoot, hostedFetch });
  apps.push(local);
  const localUrl = await local.listen({ host: "127.0.0.1", port: 0 });

  const port = await reservePort();
  const origin = `http://localhost:${port}`;
  const databasePath = path.join(directory, "trusted/server.sqlite");
  // Direct test configuration only: production's HTTPS environment validator
  // remains unchanged. Chromium treats localhost as a secure cookie context.
  const trusted = await createServerApp({
    databasePath, webRoot, hostedFetch,
    webAuth: { mode: "trusted-team", publicOrigin: origin, ownerRecoveryToken }
  });
  apps.push(trusted);
  const setup = await trusted.inject({
    method: "POST", url: "/api/auth/setup",
    headers: { origin, "x-agent-room-recovery-token": ownerRecoveryToken },
    payload: { displayName: "QA Owner" }
  });
  checked(setup, "Owner setup");
  const cookie = String(setup.headers["set-cookie"]).split(";")[0];
  const headers = { origin, cookie };
  const team = checked<{ team: { teamId: string }; owner: { memberId: string } }>(await trusted.inject({
    method: "POST", url: "/api/teams", headers, payload: { name: "产品体验验收" }
  }), "Team creation");
  const teamId = team.team.teamId;
  const room = checked<{ roomId: string }>(await trusted.inject({
    method: "POST", url: `/api/teams/${teamId}/rooms`, headers, payload: { name: "协作验收室" }
  }), "Room creation");
  const invitation = checked<{ claimUrl: string }>(await trusted.inject({
    method: "POST", url: `/api/teams/${teamId}/member-invitations`, headers, payload: { displayName: "QA成员" }
  }), "Member invitation");
  checked(await trusted.inject({
    method: "POST", url: "/api/auth/member-invitations/claim", headers: { origin },
    payload: { token: invitation.claimUrl.split("/#/join/")[1] }
  }), "Member claim");
  await seedProductExperience(trusted, { databasePath, headers, teamId, roomId: room.roomId, ownerMemberId: team.owner.memberId });
  await trusted.listen({ host: "127.0.0.1", port });
  process.stdout.write(`Local first-use preview: ${localUrl}\nTrusted Team preview: ${origin}\nSynthetic Owner recovery key: ${ownerRecoveryToken}\nOnly disposable QA data; model requests are simulated and never leave this process.\n`);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void cleanup().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  await cleanup();
  throw error;
}
