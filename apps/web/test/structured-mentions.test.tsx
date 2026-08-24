import assert from "node:assert/strict";
import test from "node:test";

import {
  removeVisibleMentionToken,
  resolveExactMentionCommands,
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

test("direct Mention commands match complete Agent names without fuzzy routing", () => {
  assert.deepEqual(
    resolveExactMentionCommands("Ask @Anna, then @Ann.", [
      { agentId: "agent_ann", name: "Ann" },
      { agentId: "agent_anna", name: "Anna" }
    ]),
    {
      agentIds: ["agent_anna", "agent_ann"],
      ambiguousNames: [],
      usesAll: false
    }
  );
  assert.deepEqual(
    resolveExactMentionCommands("Ask @Local Cod", [
      { agentId: "agent_codex", name: "Local Codex" }
    ]).agentIds,
    []
  );
  assert.deepEqual(
    resolveExactMentionCommands("Ask @Local Codex to review", [
      { agentId: "agent_codex", name: "Local Codex" }
    ]).agentIds,
    ["agent_codex"]
  );
  const overlappingAgents = [
    { agentId: "agent_local", name: "Local" },
    { agentId: "agent_codex", name: "Local Codex" }
  ];
  assert.deepEqual(
    resolveExactMentionCommands("Ask @Local Codex to review", overlappingAgents)
      .agentIds,
    ["agent_codex"]
  );
  assert.deepEqual(
    resolveExactMentionCommands(
      "Ask @Local Codex, then @Local.",
      overlappingAgents
    ).agentIds,
    ["agent_codex", "agent_local"]
  );
  const overlappingMap = new Map(overlappingAgents.map((agent) => [
    agent.agentId,
    { name: agent.name }
  ]));
  assert.deepEqual(
    retainVisibleMentionIds(
      "Ask @Local Codex",
      ["agent_local", "agent_codex"],
      overlappingMap
    ),
    ["agent_codex"]
  );
  assert.equal(
    removeVisibleMentionToken(
      "Ask @Local Codex",
      "Local",
      overlappingAgents.map(({ name }) => name)
    ),
    "Ask @Local Codex"
  );
});

test("@all is an exact reserved command and same-name Agents stay ambiguous", () => {
  const roomAgents = [
    { agentId: "agent_a", name: "Reviewer" },
    { agentId: "agent_b", name: "Reviewer" },
    { agentId: "agent_c", name: "Builder" }
  ];
  assert.deepEqual(resolveExactMentionCommands("请 @all 一起处理", roomAgents), {
    agentIds: ["agent_a", "agent_b", "agent_c"],
    ambiguousNames: [],
    usesAll: true
  });
  assert.equal(
    resolveExactMentionCommands("请 @alliance 处理", roomAgents).usesAll,
    false
  );
  assert.deepEqual(
    resolveExactMentionCommands("请 @Reviewer 处理", roomAgents),
    { agentIds: [], ambiguousNames: ["Reviewer"], usesAll: false }
  );
});
