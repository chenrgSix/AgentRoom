import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";
import type {
  MemoryReducerInput,
  MemoryReducerOutput,
  MemoryReducerRunner
} from "../src/memory/memory-reducer-runner.js";

const now = "2026-08-25T09:00:00.000Z";

class CandidateReducer implements MemoryReducerRunner {
  public readonly promptVersion = 1;

  public constructor(private readonly taskId: () => string) {}

  public async reduce(input: MemoryReducerInput): Promise<MemoryReducerOutput> {
    const sourceMessageIds = input.messages.map(({ messageId }) => messageId);
    return {
      summary: "One reviewed decision and one rejected task result.",
      provenanceMessageIds: sourceMessageIds,
      modelFingerprint: "candidate-test-v1",
      candidates: [
        {
          scopeKind: "room",
          scopeId: input.roomId,
          type: "decision",
          content: "Use SQLite for durable state. token=candidate-secret",
          sourceMessageIds
        },
        {
          scopeKind: "task",
          scopeId: this.taskId(),
          type: "result",
          content: "Candidate result awaiting review.",
          sourceMessageIds
        },
        {
          scopeKind: "room",
          scopeId: input.roomId,
          type: "decision",
          content: "Use SQLite for durable state. token=candidate-secret",
          sourceMessageIds
        }
      ]
    };
  }
}

async function waitForPendingCandidates(
  list: () => Promise<{ statusCode: number; json(): unknown }>
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await list();
    assert.equal(response.statusCode, 200);
    const candidates = response.json() as Array<Record<string, unknown>>;
    if (candidates.length === 2) return candidates;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for memory candidates");
}

test("Members atomically accept or reject non-authoritative memory candidates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-candidate-"));
  let defaultTaskId = "";
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now,
    memoryReducer: new CandidateReducer(() => defaultTaskId),
    memoryReducerSweepMilliseconds: 100
  });
  try {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    const authorization = `Bearer ${bootstrap.json().session.token as string}`;
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Memory Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const roomResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization },
      payload: { name: "memory" }
    });
    const roomId = roomResponse.json().roomId as string;
    const tasksResponse = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization }
    });
    defaultTaskId = tasksResponse.json()[0].taskId as string;
    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: { content: "Record the selected persistence decision." }
    });
    assert.equal(messageResponse.statusCode, 200);

    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/memory-candidates`
    });
    assert.equal(unauthorized.statusCode, 401);

    const candidates = await waitForPendingCandidates(() => app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/memory-candidates`,
      headers: { authorization }
    }));
    const roomCandidate = candidates.find(({ scopeKind }) => scopeKind === "room")!;
    const taskCandidate = candidates.find(({ scopeKind }) => scopeKind === "task")!;
    assert.equal((roomCandidate.content as string).includes("candidate-secret"), false);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/memory-candidates/${roomCandidate.candidateId as string}/accept`,
      headers: { authorization }
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().state, "accepted");
    assert.match(accepted.json().acceptedMemoryId as string, /^memory_/u);
    const acceptedAgain = await app.inject({
      method: "POST",
      url: `/api/memory-candidates/${roomCandidate.candidateId as string}/accept`,
      headers: { authorization }
    });
    assert.equal(acceptedAgain.json().acceptedMemoryId, accepted.json().acceptedMemoryId);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/memory-candidates/${taskCandidate.candidateId as string}/reject`,
      headers: { authorization },
      payload: { reason: "Not verified; secret=rejection-secret" }
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().state, "rejected");
    assert.equal(
      (rejected.json().rejectionReason as string).includes("rejection-secret"),
      false
    );

    const entries = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/memory-entries`,
      headers: { authorization }
    });
    assert.equal(entries.statusCode, 200);
    assert.equal(entries.json().length, 1);
    assert.equal(entries.json()[0].memoryId, accepted.json().acceptedMemoryId);
    const reviewed = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/memory-candidates?state=all`,
      headers: { authorization }
    });
    assert.deepEqual(
      reviewed.json().map((candidate: { state: string }) => candidate.state).sort(),
      ["accepted", "rejected"]
    );
  } finally {
    await app.close();
  }
});
