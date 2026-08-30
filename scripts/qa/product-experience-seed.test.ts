import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../../apps/server/src/app.js";
import { seedProductExperience } from "./product-experience-seed.js";

for (const mode of ["local", "trusted-team"] as const) test(`product experience seed creates real paging, recovery and sealed evidence projections (${mode})`, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-product-seed-test-"));
  const databasePath = path.join(directory, "server.sqlite");
  const origin = "https://qa.example.com";
  const ownerRecoveryToken = "qa-seed-owner-recovery-test-0123456789abcdef";
  const app = await createServerApp({ databasePath, clock: () => "2026-08-31T01:00:00.000Z",
    webAuth: mode === "trusted-team" ? { mode, publicOrigin: origin, ownerRecoveryToken } : { mode }
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const bootstrap = await app.inject({ method: "POST", url: mode === "trusted-team" ? "/api/auth/setup" : "/api/bootstrap",
    headers: mode === "trusted-team" ? { origin, "x-agent-room-recovery-token": ownerRecoveryToken } : {},
    payload: { displayName: "QA Owner" }
  });
  assert.equal(bootstrap.statusCode, 200);
  const headers: Record<string, string> = mode === "trusted-team"
    ? { origin, cookie: String(bootstrap.headers["set-cookie"]).split(";")[0]! }
    : { authorization: `Bearer ${bootstrap.json().session.token as string}` };
  const team = await app.inject({ method: "POST", url: "/api/teams", headers, payload: { name: "QA Team" } });
  assert.equal(team.statusCode, 200);
  const teamId = team.json().team.teamId as string;
  const ownerMemberId = team.json().owner.memberId as string;
  const room = await app.inject({ method: "POST", url: `/api/teams/${teamId}/rooms`, headers, payload: { name: "QA Room" } });
  assert.equal(room.statusCode, 200);
  const roomId = room.json().roomId as string;
  const options = { databasePath, headers, teamId, roomId, ownerMemberId };
  await seedProductExperience(app, options);
  const work = await app.inject({ method: "GET", url: `/api/teams/${teamId}/work-items?scope=mine&limit=100`, headers });
  assert.equal(work.statusCode, 200);
  assert.equal(work.json().items.length, 100);
  assert.ok(work.json().nextCursor);
  const messages = await app.inject({ method: "GET", url: `/api/rooms/${roomId}/messages?tail=true&limit=100`, headers });
  assert.equal(messages.statusCode, 200);
  assert.equal(messages.json().items.length, 100);
  assert.ok(messages.json().olderCursor);
  const tasks = await app.inject({ method: "GET", url: `/api/rooms/${roomId}/tasks`, headers });
  const taskList = tasks.json() as Array<{ taskId: string; title: string }>;
  assert.equal(taskList.filter(({ title }) => title.startsWith("QA · 分页任务")).length, 105);
  const recoveryTask = taskList.find(({ title }) => title === "QA · 确认未知结果后再发起新尝试");
  assert.ok(recoveryTask);
  const recoveryRuns = await app.inject({ method: "GET", url: `/api/tasks/${recoveryTask.taskId}/runs`, headers });
  assert.equal(recoveryRuns.json()[0].state, "outcome_unknown");
  const acknowledgement = await app.inject({ method: "GET", url: `/api/runs/${recoveryRuns.json()[0].runId as string}/ambiguity-acknowledgement`, headers });
  assert.equal(acknowledgement.json().acknowledgement, null);
  const evidenceTask = taskList.find(({ title }) => title === "QA · 核验证据并审核交付");
  assert.ok(evidenceTask);
  const results = await app.inject({ method: "GET", url: `/api/tasks/${evidenceTask.taskId}/results`, headers });
  assert.equal(results.json()[0].state, "proposed");
  const artifactId = results.json()[0].proposal.sources[0].artifactId as string;
  const preview = await app.inject({ method: "GET", url: `/api/tasks/${evidenceTask.taskId}/artifacts/${artifactId}/preview`, headers });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().integrity, "verified");
  assert.equal(preview.json().trust, "untrusted");
  assert.match(preview.json().text as string, /<script>window.qaUnsafeExecuted = true<\/script>/u);
  await assert.rejects(seedProductExperience(app, options), /Seed only once/u);
});
