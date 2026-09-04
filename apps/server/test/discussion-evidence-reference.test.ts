import assert from "node:assert/strict";
import test from "node:test";

import {
  verifyDiscussionEvidenceReferences,
  type DiscussionEvidenceReferenceLookups,
  type DiscussionEvidenceScope
} from "../src/discussion/discussion-evidence-reference.js";

const owningScope = { roomId: "room_owner", taskId: "task_owner" };
const otherRoom = { roomId: "room_other", taskId: "task_owner" };
const otherTask = { roomId: "room_owner", taskId: "task_other" };

function lookup(records: Record<string, DiscussionEvidenceScope>) {
  return (reference: string): DiscussionEvidenceScope | undefined => records[reference];
}

test("Discussion evidence verifies all supported kinds only in the owning scope", () => {
  const lookups: DiscussionEvidenceReferenceLookups = {
    message: lookup({ msg_valid: owningScope, msg_other_room: otherRoom }),
    run: lookup({ run_valid: owningScope, run_other_task: otherTask }),
    artifact: lookup({ artifact_valid: owningScope }),
    result: lookup({ result_valid: owningScope }),
    memory: lookup({
      memory_valid: owningScope,
      memory_room_only: { roomId: owningScope.roomId, taskId: null }
    }),
    discussion: lookup({ discussion_valid: owningScope })
  };

  assert.deepEqual(verifyDiscussionEvidenceReferences(owningScope, [
    "run_valid",
    "msg_other_room",
    "artifact_valid",
    "result_missing",
    "memory_valid",
    "discussion_valid",
    "opaque_claim",
    "msg_valid",
    "run_other_task",
    "result_valid",
    "memory_room_only",
    "artifact_valid"
  ], lookups), [
    "artifact_valid",
    "discussion_valid",
    "memory_valid",
    "msg_valid",
    "result_valid",
    "run_valid"
  ]);
});
