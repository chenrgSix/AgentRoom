import assert from "node:assert/strict";
import test from "node:test";

import type { MessageRecord } from "../src/data/core-repository.js";
import { TeamWaitService } from "../src/mcp/team-wait-service.js";
import type { McpPrincipal } from "../src/security/auth-service.js";
import { TeamChangeService } from "../src/team-room/team-change-service.js";

const principal: McpPrincipal = {
  agentId: "agent_wait_test",
  credentialId: "credential_wait_test",
  memberId: "member_wait_test",
  sessionId: "mcp",
  teamId: "team_wait_test",
  userId: "user_wait_test"
};

function message(sequence: number): MessageRecord {
  return {
    clientMessageId: null,
    content: `Message ${sequence}`,
    createdAt: "2026-08-29T09:00:00.000Z",
    mentions: [],
    messageId: `msg_wait_${sequence}`,
    parentMessageId: null,
    roomId: "room_wait_test",
    senderId: "member_wait_test",
    senderType: "member",
    sequence,
    taskId: "task_wait_test",
    traceId: "trace_wait_test"
  };
}

function fixture() {
  const changes = new TeamChangeService();
  const messages: MessageRecord[] = [];
  const queries = { latest: 0, list: 0 };
  let authorizations = 0;
  const core = {
    latestMessageSequence: () => {
      queries.latest += 1;
      return messages.at(-1)?.sequence ?? 0;
    },
    listMessagesAfter: (_roomId: string, sequence: number, limit: number) => {
      queries.list += 1;
      return messages.filter((item) => item.sequence > sequence).slice(0, limit);
    }
  };
  const auth = {
    requireRoomMember: () => {
      authorizations += 1;
      return {
        ...principal,
        role: "member" as const
      };
    }
  };
  return {
    auth,
    changes,
    core,
    messages,
    queries,
    service: new TeamWaitService(core, auth, changes),
    authorizations: () => authorizations
  };
}

test("team.wait times out without polling SQLite", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  subject.queries.latest = 0;
  subject.queries.list = 0;

  const result = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 100
  });

  assert.equal(result.timedOut, true);
  assert.deepEqual(result.events, []);
  assert.deepEqual(subject.queries, { latest: 1, list: 1 });
});

test("team.wait captures the change cursor before reading SQLite", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  const originalList = subject.core.listMessagesAfter;
  let firstRead = true;
  subject.core.listMessagesAfter = (roomId, sequence, limit) => {
    if (firstRead) {
      firstRead = false;
      subject.messages.push(message(1));
      subject.changes.notify("team_wait_test", {
        kind: "room",
        roomId: "room_wait_test"
      });
      subject.queries.list += 1;
      return [];
    }
    return originalList(roomId, sequence, limit);
  };

  const result = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 1_000
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events.map((item) => item.sequence), [1]);
  assert.equal(subject.queries.list, 2);
});

test("team.wait ignores unrelated changes without querying and wakes for a Run", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  subject.queries.latest = 0;
  subject.queries.list = 0;
  let settled = false;
  const pending = subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 1_000
  }).finally(() => {
    settled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  subject.changes.notify("team_wait_test", {
    kind: "room",
    roomId: "room_unrelated"
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(subject.queries, { latest: 1, list: 1 });

  subject.changes.notify("team_wait_test", {
    kind: "run",
    roomId: "room_wait_test"
  });
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, []);
  assert.deepEqual(subject.queries, { latest: 1, list: 2 });
  assert.equal(subject.authorizations(), 3);
});

test("team.wait cursor preserves a Run change that precedes the next call", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  subject.changes.notify("team_wait_test", {
    kind: "run",
    roomId: "room_wait_test"
  });

  const result = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 1_000
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, []);
});

test("team.wait conservatively resynchronizes a legacy cursor after a Run change", async () => {
  const subject = fixture();
  subject.changes.notify("team_wait_test", {
    kind: "run",
    roomId: "room_wait_test"
  });
  const legacyCursor = Buffer.from(JSON.stringify({
    roomId: "room_wait_test",
    sequence: 0
  }), "utf8").toString("base64url");

  const result = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: legacyCursor,
    timeoutMs: 1_000
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, []);
});

test("team.wait resynchronizes an old process cursor even when counters restart at zero", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  const restartedChanges = new TeamChangeService();
  const restarted = new TeamWaitService(
    subject.core,
    subject.auth,
    restartedChanges
  );

  const result = await restarted.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 1_000
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, []);
  const settled = await restarted.wait(principal, {
    roomId: "room_wait_test",
    cursor: result.cursor,
    timeoutMs: 100
  });
  assert.equal(settled.timedOut, true);
});

test("team.wait resynchronizes an old process cursor after a Room restore", async () => {
  const subject = fixture();
  subject.messages.push(message(1));
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  subject.messages.length = 0;
  const restarted = new TeamWaitService(
    subject.core,
    subject.auth,
    new TeamChangeService()
  );

  const result = await restarted.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 1_000
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, []);
  const settled = await restarted.wait(principal, {
    roomId: "room_wait_test",
    cursor: result.cursor,
    timeoutMs: 100
  });
  assert.equal(settled.timedOut, true);
});

test("team.wait returns a non-timeout resync when change history rolls over", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  for (let index = 0; index < 257; index += 1) {
    subject.changes.notify("team_wait_test", {
      kind: "room",
      roomId: "room_unrelated"
    });
  }

  const result = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    timeoutMs: 1_000
  });

  assert.equal(result.timedOut, false);
  assert.deepEqual(result.events, []);
});

test("team.wait aborts an event-driven wait without another SQLite query", async () => {
  const subject = fixture();
  const baseline = await subject.service.wait(principal, {
    roomId: "room_wait_test",
    timeoutMs: 100
  });
  subject.queries.latest = 0;
  subject.queries.list = 0;
  const controller = new AbortController();
  const pending = subject.service.wait(principal, {
    roomId: "room_wait_test",
    cursor: baseline.cursor,
    signal: controller.signal,
    timeoutMs: 1_000
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("team.wait test abort"));
  await assert.rejects(pending, /team\.wait test abort/u);
  assert.deepEqual(subject.queries, { latest: 1, list: 1 });
});
