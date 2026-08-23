import assert from "node:assert/strict";
import test from "node:test";

import {
  removeVisibleMentionToken,
  retainVisibleMentionIds
} from "../src/structured-mentions.js";

const agents = new Map([
  ["agent_ann", { name: "Ann" }],
  ["agent_anna", { name: "Anna" }],
  ["agent_ann_reviewer", { name: "Ann" }]
]);

test("structured Mention matching respects complete name boundaries", () => {
  assert.deepEqual(
    retainVisibleMentionIds("Ask @Anna ", ["agent_ann"], agents),
    []
  );
  assert.deepEqual(
    retainVisibleMentionIds("Ask @Anna, then @Ann.", ["agent_ann", "agent_anna"], agents),
    ["agent_ann", "agent_anna"]
  );
  assert.equal(
    removeVisibleMentionToken("Ask @Anna, then @Ann.", "Ann"),
    "Ask @Anna, then ."
  );
});

test("same-name Agent IDs are retained only for visible token occurrences", () => {
  assert.deepEqual(
    retainVisibleMentionIds(
      "@Ann compare with @Ann ",
      ["agent_ann", "agent_ann_reviewer"],
      agents
    ),
    ["agent_ann", "agent_ann_reviewer"]
  );
  assert.deepEqual(
    retainVisibleMentionIds(
      "@Ann compare",
      ["agent_ann", "agent_ann_reviewer"],
      agents
    ),
    ["agent_ann"]
  );
});
