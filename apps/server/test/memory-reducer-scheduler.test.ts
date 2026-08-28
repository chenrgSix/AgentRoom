import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import type {
  MemoryReducerInput,
  MemoryReducerRunner
} from "../src/memory/memory-reducer-runner.js";
import {
  ExtractiveMemoryReducerRunner
} from "../src/memory/memory-reducer-runner.js";
import {
  MemoryReducerScheduler
} from "../src/memory/memory-reducer-scheduler.js";
import {
  evaluateMemorySummaryQuality
} from "../src/memory/memory-summary-quality.js";
import {
  RollingRoomMemoryRepository
} from "../src/memory/rolling-room-memory-repository.js";

const initialNow = "2026-08-25T16:00:00.000Z";

class CapturingReducer implements MemoryReducerRunner {
  public readonly promptVersion = 7;
  public readonly calls: MemoryReducerInput[] = [];

  public async reduce(input: MemoryReducerInput) {
    this.calls.push(input);
    return {
      summary: `Processed Room evidence through ${input.throughSequence}.`,
      provenanceMessageIds: input.messages.slice(-2).map(({ messageId }) => messageId),
      modelFingerprint: "configured-test-runner-v1",
      candidates: [{
        scopeKind: "room" as const,
        scopeId: input.roomId,
        type: "decision" as const,
        content: "A candidate must not control checkpoint commit.",
        sourceMessageIds: [input.messages.at(-1)!.messageId]
      }]
    };
  }
}

test("configured Room reduction drains, rebases, redacts, and isolates candidates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-reducer-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    core.createUser({
      userId: "user_reducer_12345678",
      displayName: "Alice",
      createdAt: initialNow
    });
    core.createTeamWithOwner(
      { teamId: "team_reducer_12345678", name: "Reducer", createdAt: initialNow },
      {
        memberId: "member_reducer_12345678",
        teamId: "team_reducer_12345678",
        userId: "user_reducer_12345678",
        displayName: "Alice",
        role: "owner",
        createdAt: initialNow
      }
    );
    const roomId = "room_reducer_12345678";
    core.createRoom({
      roomId,
      teamId: "team_reducer_12345678",
      name: "architecture",
      createdAt: initialNow
    });
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      core.appendMessage({
        messageId: `msg_reducer_${sequence}_12345678`,
        roomId,
        senderType: "member",
        senderId: "member_reducer_12345678",
        content: sequence === 1
          ? "token=super-sensitive-reducer-value"
          : `Room evidence ${sequence}`,
        mentions: [],
        parentMessageId: null,
        createdAt: initialNow
      });
    }
    let clockValue = initialNow;
    const reducer = new CapturingReducer();
    let candidateAttempts = 0;
    const rolling = new RollingRoomMemoryRepository(database);
    const scheduler = new MemoryReducerScheduler(
      core,
      rolling,
      reducer,
      () => clockValue,
      {
        persistSuggestions: () => {
          candidateAttempts += 1;
          throw new Error("candidate output rejected independently");
        }
      }
    );

    const first = await scheduler.sweep();
    assert.deepEqual(first, {
      attemptedRooms: 1,
      committedCheckpoints: 1,
      failedRooms: 0,
      candidateFailures: 1
    });
    assert.equal(rolling.getState(roomId)?.latestThroughSequence, 32);
    assert.equal(rolling.getState(roomId)?.desiredThroughSequence, 40);
    assert.equal(reducer.calls[0]?.messages[0]?.content, "[REDACTED]");
    assert.equal(reducer.calls[0]?.buildKind, "incremental");

    const second = await scheduler.sweep();
    assert.equal(second.committedCheckpoints, 1);
    assert.equal(rolling.getState(roomId)?.latestThroughSequence, 40);
    assert.equal(reducer.calls[1]?.previousCheckpoint?.throughSequence, 32);

    for (let sequence = 41; sequence <= 45; sequence += 1) {
      core.appendMessage({
        messageId: `msg_reducer_${sequence}_12345678`,
        roomId,
        senderType: "member",
        senderId: "member_reducer_12345678",
        content: `Room evidence ${sequence}`,
        mentions: [],
        parentMessageId: null,
        createdAt: initialNow
      });
    }
    const rebased = await scheduler.drainRoom(roomId, { rebase: true });
    assert.deepEqual(rebased, {
      committed: true,
      failed: false,
      candidateFailed: true
    });
    const rebaseCheckpoint = rolling.getCheckpoint(
      rolling.getState(roomId)!.latestCheckpointId!
    );
    assert.equal(rebaseCheckpoint?.buildKind, "rebase");
    assert.equal(rebaseCheckpoint?.parentCheckpointId, null);
    assert.equal(rebaseCheckpoint?.inputFromSequenceExclusive, 0);
    assert.equal(rebaseCheckpoint?.throughSequence, 45);
    assert.equal(reducer.calls[2]?.previousCheckpoint, undefined);

    core.appendMessage({
      messageId: "msg_reducer_46_12345678",
      roomId,
      senderType: "member",
      senderId: "member_reducer_12345678",
      content: "Room evidence 46",
      mentions: [],
      parentMessageId: null,
      createdAt: initialNow
    });
    assert.ok(rolling.acquireLease({
      roomId,
      leaseToken: "lease_reducer_crashed_worker_12345678",
      now: clockValue,
      leaseExpiresAt: "2026-08-25T16:01:00.000Z"
    }));
    assert.equal((await scheduler.sweep()).committedCheckpoints, 0);
    clockValue = "2026-08-25T16:02:00.000Z";
    assert.equal((await scheduler.sweep()).committedCheckpoints, 1);
    assert.equal(rolling.getState(roomId)?.latestThroughSequence, 46);
    assert.equal(candidateAttempts, 4);

    const quality = evaluateMemorySummaryQuality(
      rebaseCheckpoint?.summary ?? "",
      rebaseCheckpoint?.provenance ?? [],
      {
        expectedClaims: ["wire compatibility", "PostgreSQL decision"],
        forbiddenClaims: ["PostgreSQL was approved"],
        requiredProvenanceMessageIds: ["msg_reducer_45_12345678"]
      }
    );
    assert.deepEqual(quality, {
      claimRecall: 0,
      falseClaimCount: 0,
      provenanceRecall: 1
    });
    assert.equal(rolling.getState(roomId)?.mode, "ready");
  } finally {
    database.close();
  }
});

test("extractive reducer remains bounded and labels its non-semantic baseline", async () => {
  const runner = new ExtractiveMemoryReducerRunner();
  const output = await runner.reduce({
    roomId: "room_extract_12345678",
    buildKind: "incremental",
    fromSequenceExclusive: 1,
    throughSequence: 2,
    previousCheckpoint: {
      checkpointId: "checkpoint_extract_12345678",
      throughSequence: 1,
      summary: "Earlier evidence."
    },
    messages: [{
      messageId: "msg_extract_2_12345678",
      sequence: 2,
      senderType: "member",
      senderId: "member_extract_12345678",
      content: "Keep this as quoted evidence."
    }]
  });
  assert.equal(output.modelFingerprint, "extractive-v1");
  assert.ok(output.summary.length <= 12_000);
  assert.match(output.summary, /Earlier evidence/u);
  assert.match(output.summary, /quoted evidence/u);
  assert.deepEqual(output.provenanceMessageIds, ["msg_extract_2_12345678"]);
  assert.equal(output.candidates, undefined);
});
