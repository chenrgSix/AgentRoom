import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest,
  validateExecutionDecision,
  validateExecutionPlanDefinition
} from "../src/execution-validation.mjs";

const suite = JSON.parse(await readFile(
  new URL("../fixtures/execution-plan-cases.json", import.meta.url), "utf8"
));
const template = suite.cases.find((entry) => entry.name === "execution: valid full plan").instance;
const plan = () => structuredClone(template);
const reject = (value, code) => assert.throws(() => validateExecutionPlanDefinition(value),
  (error) => error.name === "ExecutionContractError" && error.code === code &&
    error.message === code);

test("plan validation returns detached normalized content, exact digest and binary topology", () => {
  const input = plan();
  const before = structuredClone(input);
  const result = validateExecutionPlanDefinition(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.topologicalOrder, ["Build", "Review"]);
  assert.deepEqual(result.approvalBlockers, []);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);
  result.definition.nodes[0].task.title = "Changed copy";
  assert.deepEqual(input, before);
});

test("plan identity is independent of set and JSON key order without hiding semantic changes", () => {
  const first = plan();
  const baseline = validateExecutionPlanDefinition(first);
  const reversedKeys = (value) => Array.isArray(value)
    ? value.map(reversedKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) =>
          [key, reversedKeys(child)]))
      : value;
  const permuted = reversedKeys(first);
  permuted.nodes.reverse();
  permuted.nodes[1].scope.allowedPaths.reverse();
  assert.deepEqual(validateExecutionPlanDefinition(permuted), baseline);
  for (const change of [
    (value) => { value.nodes[0].scope.allowedPaths.push("db"); },
    (value) => { value.policy.budget.maxRunAttempts += 1; },
    (value) => { value.nodes[0].task.criteria[0].description = "New criterion"; },
    (value) => { value.nodes[0].repository.grantRevision += 1; },
    (value) => { value.nodes[0].verificationProfiles[0].digest = "e".repeat(64); },
    (value) => { value.edges[0].gate = "accepted_result"; }
  ]) {
    const changed = plan();
    change(changed);
    assert.notEqual(validateExecutionPlanDefinition(changed).digest, baseline.digest);
  }
});

test("canonical encoding preserves arrays and sorts object keys without numeric-key reordering", () => {
  const expected = '{"10":1,"2":2,"a":{"x":1},"z":[2,1]}';
  const input = { z: [2, 1], a: { x: 1 }, 2: 2, 10: 1 };
  assert.equal(canonicalExecutionJSON(input), expected);
  assert.equal(executionOperationDigest(input),
    createHash("sha256").update(expected).digest("hex"));
  assert.notEqual(executionOperationDigest(input),
    executionOperationDigest({ ...input, z: [1, 2] }));
});

test("required questions block approval without losing an otherwise valid draft", () => {
  const input = plan();
  input.decision.unresolvedQuestions = [
    { questionKey: "optional", text: "Optional consideration", required: false },
    { questionKey: "security", text: "Who approves the threat model?", required: true }
  ];
  assert.deepEqual(validateExecutionPlanDefinition(input).approvalBlockers, ["security"]);
  assert.deepEqual(validateExecutionDecision(input.decision), input.decision);
});

test("source actions bind canonical Result evidence and cannot be compiled twice", () => {
  const input = structuredClone(suite.cases.find((entry) => entry.name === "execution: valid source-action plan").instance);
  const original = validateExecutionPlanDefinition(input);
  const missing = structuredClone(input);
  missing.decision.sources = missing.decision.sources.filter((source) => source.kind !== "result");
  missing.decision.sourceRevisions = missing.decision.sourceRevisions.filter((pin) => pin.evidenceRefId !== "evidence_action0001");
  reject(missing, "PLAN_SOURCE_ACTION_EVIDENCE_REQUIRED");
  input.nodes[1].task.sourceAction = { ...input.nodes[0].task.sourceAction };
  reject(input, "PLAN_DUPLICATE_SOURCE_ACTION");
  input.nodes[1].task.sourceAction.nextActionKey = "next_review0001";
  assert.notEqual(validateExecutionPlanDefinition(input).digest, original.digest);
});

const mutations = [
  ["duplicate nodes", "PLAN_DUPLICATE_NODE", (p) => p.nodes.push(structuredClone(p.nodes[0]))],
  ["duplicate edge IDs", "PLAN_DUPLICATE_EDGE", (p) => p.edges.push(structuredClone(p.edges[0]))],
  ["duplicate endpoint pair", "PLAN_DUPLICATE_EDGE_PAIR", (p) => p.edges.push({ ...p.edges[0], edgeKey: "second" })],
  ["self dependency", "PLAN_SELF_EDGE", (p) => { p.edges[0].toNodeKey = "Build"; }],
  ["missing endpoint", "PLAN_EDGE_NODE_MISSING", (p) => { p.edges[0].fromNodeKey = "Missing"; }],
  ["cycle", "PLAN_CYCLE", (p) => p.edges.push({ edgeKey: "back", fromNodeKey: "Review", toNodeKey: "Build", gate: "accepted_result", bindings: [] })],
  ["missing required input", "PLAN_REQUIRED_INPUT_MISSING", (p) => { p.edges[0].bindings = []; }],
  ["missing output slot", "PLAN_OUTPUT_SLOT_MISSING", (p) => { p.edges[0].bindings[0].outputSlot = "missing"; }],
  ["wrong input kind", "PLAN_INPUT_SLOT_MISMATCH", (p) => { p.nodes[1].inputs[0].kind = "document"; }],
  ["duplicate producer", "PLAN_MULTIPLE_INPUT_PRODUCERS", (p) => p.edges[0].bindings.push({ ...p.edges[0].bindings[0] })],
  ["duplicate input slot", "PLAN_DUPLICATE_INPUT", (p) => p.nodes[1].inputs.push({ ...p.nodes[1].inputs[0] })],
  ["duplicate output slot", "PLAN_DUPLICATE_OUTPUT", (p) => p.nodes[0].outputs.push({ ...p.nodes[0].outputs[0] })],
  ["duplicate verifier profile", "PLAN_DUPLICATE_PROFILE", (p) => p.nodes[0].verificationProfiles.push({ ...p.nodes[0].verificationProfiles[0] })],
  ["unisolated implementation", "PLAN_WRITER_NOT_ISOLATED", (p) => { p.nodes[0].scope.access = "read_only"; p.nodes[0].scope.allowedPaths = []; }],
  ["reviewer requesting writes", "PLAN_REVIEWER_WRITE_SCOPE", (p) => { p.nodes[1].scope.access = "isolated_write"; p.nodes[1].scope.allowedPaths = ["src"]; }],
  ["read-only write envelope", "PLAN_READ_ONLY_WRITE_SCOPE", (p) => { p.nodes[1].scope.allowedPaths = ["src"]; }],
  ["missing write scope", "PLAN_WRITE_SCOPE_MISSING", (p) => { p.nodes[0].scope.allowedPaths = []; }],
  ["entire scope forbidden", "PLAN_WRITE_SCOPE_FULLY_FORBIDDEN", (p) => { p.nodes[0].scope.forbiddenPaths = ["."]; }],
  ["missing required verifier", "PLAN_REQUIRED_VERIFICATION_MISSING", (p) => { p.nodes[0].verificationProfiles[0].required = false; }],
  ["no code delivery", "PLAN_CODE_OUTPUT_MISSING", (p) => { p.nodes[0].outputs[0].kind = "document"; }],
  ["duplicate criterion", "PLAN_DUPLICATE_CRITERION", (p) => p.nodes[0].task.criteria.push({ ...p.nodes[0].task.criteria[0], ordinal: 2 })],
  ["noncontiguous criteria", "PLAN_CRITERIA_ORDER", (p) => { p.nodes[0].task.criteria[0].ordinal = 2; }],
  ["missing required criteria", "PLAN_REQUIRED_CRITERION_MISSING", (p) => { p.nodes[0].task.criteria[0].required = false; }],
  ["blank text", "PLAN_EMPTY_TEXT", (p) => { p.title = "  \n "; }],
  ["no required nodes", "PLAN_REQUIRED_NODE_MISSING", (p) => p.nodes.forEach((node) => { node.required = false; })],
  ["insufficient total attempts", "PLAN_BUDGET_BELOW_REQUIRED_NODES", (p) => { p.policy.budget.maxRunAttempts = 1; }],
  ["duplicate decision", "PLAN_DUPLICATE_DECISION", (p) => p.decision.items.push({ ...p.decision.items[0] })],
  ["duplicate source alias", "PLAN_DUPLICATE_SOURCE", (p) => {
    p.decision.sources.push({ ...p.decision.sources[0], evidenceRefId: "evidence_00000002" });
    p.decision.sourceRevisions.push({ evidenceRefId: "evidence_00000002", revision: 1 });
  }],
  ["missing source revision", "PLAN_SOURCE_REVISION_MISMATCH", (p) => { p.decision.sourceRevisions[0].evidenceRefId = "evidence_00000002"; }],
  ["duplicate source revision", "PLAN_DUPLICATE_SOURCE_REVISION", (p) => p.decision.sourceRevisions.push({ ...p.decision.sourceRevisions[0] })],
  ["base drift", "PLAN_REPOSITORY_BASE_CONFLICT", (p) => { p.nodes[1].repository.baseCommit = "b".repeat(40); }],
  ["binding reused for foreign repository", "PLAN_REPOSITORY_BINDING_CONFLICT", (p) => { p.nodes[1].repository.repositoryId = "repo_00000002"; }],
  ["cross-repository patch", "PLAN_CROSS_REPOSITORY_CODE_INPUT", (p) => { p.nodes[1].repository.repositoryId = "repo_00000002"; p.nodes[1].repository.bindingId = "repobind_00000002"; }],
  ["integration gate without integration", "PLAN_INTEGRATION_GATE_UNAVAILABLE", (p) => { p.edges[0].gate = "integrated_commit"; }],
  ["integration without target", "PLAN_INTEGRATION_TARGET_MISSING", (p) => { p.policy.integration = "local_integration"; }]
];

for (const [name, code, mutate] of mutations) {
  test(`plan rejects ${name}`, () => {
    const input = plan();
    mutate(input);
    reject(input, code);
  });
}

for (const unsafePath of ["../src", "src/../db", ".git/config", "src/.Git/config", "src/./auth", "src ", "src."]) {
  test(`plan rejects unsafe path ${unsafePath}`, () => {
    const input = plan();
    input.nodes[0].scope.allowedPaths = [unsafePath];
    reject(input, "PLAN_UNSAFE_PATH");
  });
}

test("existing Task pins reject root-as-node and aliases of one Task", () => {
  const input = plan();
  const existing = { mode: "existing", taskId: input.rootTaskId,
    expectedTaskRevision: 1, definitionRevision: 1, criteriaRevision: 1 };
  input.nodes[0].task = existing;
  reject(input, "PLAN_ROOT_IS_NODE");
  existing.taskId = "task_00000002";
  input.nodes[1].task = { ...existing };
  reject(input, "PLAN_DUPLICATE_TASK");
  input.nodes[1].task.taskId = "task_00000003";
  assert.deepEqual(validateExecutionPlanDefinition(input).topologicalOrder, ["Build", "Review"]);
});

test("explicit external inputs satisfy one typed slot but never duplicate an edge producer", () => {
  const input = plan();
  const external = suite.cases.find((entry) => entry.name === "execution: valid exact external input").instance;
  input.externalInputs = [structuredClone(external)];
  reject(input, "PLAN_MULTIPLE_INPUT_PRODUCERS");
  input.edges[0].bindings = [];
  assert.deepEqual(validateExecutionPlanDefinition(input).topologicalOrder, ["Build", "Review"]);
  input.externalInputs[0].nodeKey = "Missing";
  reject(input, "PLAN_INPUT_SLOT_MISMATCH");
});

test("integration targets pin a logical repository and exact base", () => {
  const input = plan();
  input.policy.integration = "local_integration";
  const target = { repositoryId: input.nodes[0].repository.repositoryId,
    targetRef: "refs/heads/main", expectedCommit: input.nodes[0].repository.baseCommit };
  input.policy.integrationTargets = [target];
  validateExecutionPlanDefinition(input);
  target.expectedCommit = "b".repeat(40);
  reject(input, "PLAN_INTEGRATION_BASE_CONFLICT");
  target.expectedCommit = input.nodes[0].repository.baseCommit;
  for (const ref of ["refs/heads/main..old", "refs/heads/main.lock", "refs/heads/a//b", "refs/heads/a/", "refs/heads/a/.hidden"]) {
    target.targetRef = ref;
    reject(input, "PLAN_INTEGRATION_TARGET_INVALID");
  }
});

test("binary scheduling handles disconnected nodes in a reproducible order", () => {
  const input = plan();
  input.edges = [];
  input.nodes[1].inputs = [];
  input.nodes[0].nodeKey = "z";
  input.nodes[1].nodeKey = "Z";
  assert.deepEqual(validateExecutionPlanDefinition(input).topologicalOrder, ["Z", "z"]);
});

test("JSON admission rejects executable, cyclic, sparse, oversized and malformed values", () => {
  const cycle = {}; cycle.self = cycle;
  const sparse = Array(1); sparse.other = "not an array item";
  const getter = Object.defineProperty({}, "value", { enumerable: true,
    get() { assert.fail("getter must not be invoked"); } });
  for (const value of [undefined, NaN, Infinity, 1.5, 1n, () => {}, new Date(), cycle,
    sparse, getter, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => canonicalExecutionJSON(value), /PLAN_NON_JSON_VALUE/);
  }
  assert.throws(() => canonicalExecutionJSON("\ud800"), /PLAN_INVALID_UNICODE/);
  assert.throws(() => canonicalExecutionJSON("x".repeat(512 * 1024 + 1)), /PLAN_RESOURCE_LIMIT/);
  assert.throws(() => canonicalExecutionJSON(Array(30_001).fill(null)), /PLAN_RESOURCE_LIMIT/);
  assert.throws(() => assertExecutionCommand("constructor", {}), /PLAN_SCHEMA_INVALID/);
  assert.equal(canonicalExecutionJSON({ title: "验证 😀", value: null }), '{"title":"验证 😀","value":null}');
});

test("schema admission rejects excess graph size before graph processing", () => {
  const input = plan();
  input.nodes = Array.from({ length: 65 }, (_, index) => ({ ...input.nodes[1],
    nodeKey: `node${index}`, inputs: [] }));
  input.edges = [];
  reject(input, "PLAN_SCHEMA_INVALID");
});

test("optional outputs cannot stand in for mandatory downstream inputs", () => {
  const input = plan();
  input.nodes[0].outputs.push({ slotKey: "optionalPatch", kind: "patch", required: false });
  input.edges[0].bindings[0].outputSlot = "optionalPatch";
  reject(input, "PLAN_OPTIONAL_REQUIRED_INPUT");
});

test("required verification is a distinct dependency gate, not an Agent claim", () => {
  const input = plan();
  input.edges = [];
  input.nodes[1].inputs = [];
  input.nodes[1].verificationProfiles = [];
  input.edges.push({ edgeKey: "review_build", fromNodeKey: "Review",
    toNodeKey: "Build", gate: "verified_output", bindings: [] });
  reject(input, "PLAN_UNVERIFIABLE_EDGE");
  input.edges[0].gate = "accepted_result";
  assert.deepEqual(validateExecutionPlanDefinition(input).topologicalOrder, ["Review", "Build"]);
});
