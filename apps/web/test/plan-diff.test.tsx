import assert from "node:assert/strict";
import test from "node:test";

import {
  diffPlanDefinitions,
  displayPlanDiffValue
} from "../src/features/work/plan-diff.js";

test("plan diff is deterministic path-specific and bounded", () => {
  const before = {
    title: "Before",
    nodes: [{ nodeKey: "build", required: true }],
    policy: { maxConcurrency: 1, removed: "old" }
  };
  const after = {
    title: "After",
    nodes: [
      { nodeKey: "build", required: false },
      { nodeKey: "review", required: true }
    ],
    policy: { maxConcurrency: 2, added: "new" }
  };
  assert.deepEqual(diffPlanDefinitions(before, after).map(({ kind, path }) =>
    `${kind}:${path}`), [
    "changed:$plan.nodes[0].required",
    "added:$plan.nodes[1]",
    "added:$plan.policy.added",
    "changed:$plan.policy.maxConcurrency",
    "removed:$plan.policy.removed",
    "changed:$plan.title"
  ]);
  assert.equal(diffPlanDefinitions(after, structuredClone(after)).length, 0);
  assert.equal(displayPlanDiffValue("x".repeat(500)).length, 240);
  assert.equal(diffPlanDefinitions(
    Array.from({ length: 600 }, (_, index) => index),
    Array.from({ length: 600 }, (_, index) => index + 1)
  ).length, 500);
});
