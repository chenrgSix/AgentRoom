import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import {
  RollingRoomMemoryRepository,
  type RollingRoomCheckpoint
} from "../src/memory/rolling-room-memory-repository.js";

const now = "2026-08-25T15:00:00.000Z";
const roomId = "room_rolling_memory_12345678";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("rolling Room checkpoints drain a durable watermark without cursor regression", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-rolling-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  let database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    core.createUser({
      userId: "user_rolling_memory_12345678",
      displayName: "Alice",
      createdAt: now
    });
    core.createTeamWithOwner(
      {
        teamId: "team_rolling_memory_12345678",
        name: "Rolling Team",
        createdAt: now
      },
      {
        memberId: "member_rolling_memory_12345678",
        teamId: "team_rolling_memory_12345678",
        userId: "user_rolling_memory_12345678",
        displayName: "Alice",
        role: "owner",
        createdAt: now
      }
    );
    core.createRoom({
      roomId,
      teamId: "team_rolling_memory_12345678",
      name: "architecture",
      createdAt: now
    });
    const messageIds = [1, 2, 3].map((sequence) => {
      const messageId = `msg_rolling_memory_${sequence}_12345678`;
      core.appendMessage({
        messageId,
        roomId,
        senderType: "member",
        senderId: "member_rolling_memory_12345678",
        content: `Room evidence ${sequence}`,
        mentions: [],
        parentMessageId: null,
        createdAt: now
      });
      return messageId;
    });

    const repository = new RollingRoomMemoryRepository(database);
    assert.deepEqual(repository.getState(roomId), {
      roomId,
      mode: "disabled",
      latestCheckpointId: null,
      latestThroughSequence: 0,
      desiredThroughSequence: 3,
      generation: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now
    });
    assert.equal(repository.enable(roomId, now).mode, "backfilling");

    const firstLease = repository.acquireLease({
      roomId,
      leaseToken: "lease_rolling_first_12345678",
      now,
      leaseExpiresAt: "2026-08-25T15:05:00.000Z"
    });
    assert.equal(firstLease?.generation, 1);
    const first: RollingRoomCheckpoint = {
      checkpointId: "checkpoint_rolling_first_12345678",
      roomId,
      parentCheckpointId: null,
      inputFromSequenceExclusive: 0,
      throughSequence: 2,
      summary: "The first two Room messages were processed.",
      provenance: messageIds.slice(0, 2),
      sourceMessageCount: 2,
      sourceDigest: digest("messages-1-2"),
      promptVersion: 1,
      modelFingerprint: "deterministic-test-v1",
      buildKind: "incremental",
      createdAt: now
    };
    repository.commitCheckpoint({
      checkpoint: first,
      expectedGeneration: firstLease?.generation ?? 0,
      leaseToken: "lease_rolling_first_12345678",
      now
    });
    assert.equal(repository.getState(roomId)?.latestThroughSequence, 2);
    assert.equal(repository.getState(roomId)?.desiredThroughSequence, 3);
    assert.throws(() => repository.commitCheckpoint({
      checkpoint: { ...first, checkpointId: "checkpoint_stale_retry_12345678" },
      expectedGeneration: 1,
      leaseToken: "lease_rolling_first_12345678",
      now
    }), /lease is stale/u);

    const secondLease = repository.acquireLease({
      roomId,
      leaseToken: "lease_rolling_second_12345678",
      now,
      leaseExpiresAt: "2026-08-25T15:05:00.000Z"
    });
    const second: RollingRoomCheckpoint = {
      checkpointId: "checkpoint_rolling_second_12345678",
      roomId,
      parentCheckpointId: first.checkpointId,
      inputFromSequenceExclusive: 2,
      throughSequence: 3,
      summary: "All three Room messages were processed.",
      provenance: [messageIds[2] ?? ""],
      sourceMessageCount: 1,
      sourceDigest: digest("message-3"),
      promptVersion: 1,
      modelFingerprint: "deterministic-test-v1",
      buildKind: "incremental",
      createdAt: now
    };
    repository.commitCheckpoint({
      checkpoint: second,
      expectedGeneration: secondLease?.generation ?? 0,
      leaseToken: "lease_rolling_second_12345678",
      now
    });
    assert.equal(repository.getState(roomId)?.latestThroughSequence, 3);
    assert.equal(repository.acquireLease({
      roomId,
      leaseToken: "lease_no_work_remaining_12345678",
      now,
      leaseExpiresAt: "2026-08-25T15:05:00.000Z"
    }), undefined);
    assert.equal(repository.latestAtOrBefore(roomId, 2)?.checkpointId, first.checkpointId);
    assert.throws(() => database.prepare(`
      UPDATE rolling_room_checkpoints SET summary = 'mutated'
      WHERE checkpoint_id = ?
    `).run(first.checkpointId), /immutable/u);

    database.close();
    database = openDatabase(databasePath);
    const reopened = new RollingRoomMemoryRepository(database);
    assert.equal(reopened.getState(roomId)?.latestCheckpointId, second.checkpointId);
    assert.equal(reopened.getCheckpoint(first.checkpointId)?.summary, first.summary);
  } finally {
    if (database.open) database.close();
  }
});
