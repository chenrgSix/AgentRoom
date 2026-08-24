import assert from "node:assert/strict";
import test from "node:test";

import {
  createClientMessageId,
  queuePendingMessage,
  updatePendingMessage
} from "../src/message-outbox.js";

test("pending Room Messages retain one client identity across failure and retry", () => {
  const clientMessageId = createClientMessageId("01K4Z6J7Y8N9P0Q1R2S3T4V5W6");
  const queued = queuePendingMessage([], {
    clientMessageId,
    roomId: "room_test",
    content: "deliver once",
    status: "pending"
  });
  const failed = updatePendingMessage(queued, clientMessageId, "failed");
  const retried = queuePendingMessage(failed, { ...failed[0]!, status: "pending" });

  assert.match(clientMessageId, /^client_[A-Za-z0-9_-]{8,128}$/u);
  assert.equal(failed[0]?.status, "failed");
  assert.deepEqual(retried, [{ ...queued[0], status: "pending" }]);
});
