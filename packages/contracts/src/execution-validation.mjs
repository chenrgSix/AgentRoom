import { createHash } from "node:crypto";

import validators from "../generated/runtime/execution-plan-validator.cjs";

const maximumBytes = 512 * 1024;
const maximumValues = 30_000;
const binaryCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const by = (key) => (left, right) => binaryCompare(left[key], right[key]);

export class ExecutionContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "ExecutionContractError";
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new ExecutionContractError(code);
}

function assertPlainJSON(value) {
  const active = new Set();
  let count = 0;
  let textSize = 0;
  const visit = (entry, depth) => {
    requireCondition(++count <= maximumValues && depth <= 24, "PLAN_RESOURCE_LIMIT");
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      requireCondition(Number.isSafeInteger(entry), "PLAN_NON_JSON_VALUE");
      return;
    }
    if (typeof entry === "string") {
      textSize += Buffer.byteLength(entry, "utf8");
      requireCondition(textSize <= maximumBytes, "PLAN_RESOURCE_LIMIT");
      requireCondition(entry.isWellFormed(), "PLAN_INVALID_UNICODE");
      return;
    }
    requireCondition(typeof entry === "object", "PLAN_NON_JSON_VALUE");
    const prototype = Object.getPrototypeOf(entry);
    requireCondition(Array.isArray(entry) || prototype === Object.prototype ||
      prototype === null, "PLAN_NON_JSON_VALUE");
    requireCondition(!active.has(entry), "PLAN_NON_JSON_VALUE");
    active.add(entry);
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    requireCondition(Object.getOwnPropertySymbols(entry).length === 0,
      "PLAN_NON_JSON_VALUE");
    if (Array.isArray(entry)) {
      requireCondition(entry.length <= maximumValues, "PLAN_RESOURCE_LIMIT");
      requireCondition(Object.keys(descriptors).length === entry.length + 1,
        "PLAN_NON_JSON_VALUE");
      for (let index = 0; index < entry.length; index += 1) {
        requireCondition(Object.hasOwn(descriptors, String(index)), "PLAN_NON_JSON_VALUE");
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(entry) && key === "length") continue;
      requireCondition(descriptor.enumerable && "value" in descriptor &&
        key !== "__proto__" && key !== "constructor" && key !== "prototype",
      "PLAN_NON_JSON_VALUE");
      visit(key, depth + 1);
      visit(descriptor.value, depth + 1);
    }
    active.delete(entry);
  };
  visit(value, 0);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(binaryCompare).map((key) =>
      `${JSON.stringify(key)}:${canonicalValue(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalExecutionJSON(value) {
  assertPlainJSON(value);
  const encoded = canonicalValue(value);
  requireCondition(Buffer.byteLength(encoded, "utf8") <= maximumBytes,
    "PLAN_RESOURCE_LIMIT");
  return encoded;
}

export function executionOperationDigest(value) {
  return createHash("sha256").update(canonicalExecutionJSON(value)).digest("hex");
}

export function assertExecutionCommand(kind, value) {
  canonicalExecutionJSON(value);
  const validator = Object.hasOwn(validators, kind) ? validators[kind] : undefined;
  requireCondition(typeof validator === "function" && validator(value),
    "PLAN_SCHEMA_INVALID");
}

function unique(entries, key, code) {
  const keys = entries.map((entry) => entry[key]);
  requireCondition(new Set(keys).size === keys.length, code);
}

function nonblank(value) {
  requireCondition(value.trim().length > 0, "PLAN_EMPTY_TEXT");
}

function validateDecision(decision) {
  nonblank(decision.summary);
  unique(decision.items, "itemKey", "PLAN_DUPLICATE_DECISION");
  unique(decision.unresolvedQuestions, "questionKey", "PLAN_DUPLICATE_QUESTION");
  unique(decision.sources, "evidenceRefId", "PLAN_DUPLICATE_SOURCE");
  unique(decision.sourceRevisions, "evidenceRefId", "PLAN_DUPLICATE_SOURCE_REVISION");
  requireCondition(decision.sourceRevisions.length === decision.sources.length &&
    decision.sources.every((source) => decision.sourceRevisions.some((pin) =>
      pin.evidenceRefId === source.evidenceRefId)), "PLAN_SOURCE_REVISION_MISMATCH");
  decision.items.forEach((item) => nonblank(item.statement));
  decision.unresolvedQuestions.forEach((question) => nonblank(question.text));
  const sourcePins = decision.sources.map(({ evidenceRefId: _key, ...source }) =>
    canonicalValue(source)
  );
  requireCondition(new Set(sourcePins).size === sourcePins.length,
    "PLAN_DUPLICATE_SOURCE");
}

export function validateExecutionDecision(value) {
  assertExecutionCommand("decisionContent", value);
  validateDecision(value);
  return structuredClone(value);
}

function validatePrefix(prefix) {
  if (prefix === ".") return;
  requireCondition(prefix === prefix.trim() && prefix.split("/").every((part) =>
    part !== "." && part !== ".." && part.toLowerCase() !== ".git" &&
    part === part.trim() && !part.endsWith(".")
  ), "PLAN_UNSAFE_PATH");
}

function validateNode(node, rootTaskId) {
  if (node.task.mode === "new") {
    nonblank(node.task.title);
    nonblank(node.task.goal);
    unique(node.task.criteria, "criterionKey", "PLAN_DUPLICATE_CRITERION");
    const criteria = [...node.task.criteria].sort((a, b) => a.ordinal - b.ordinal);
    requireCondition(criteria.every((criterion, index) => criterion.ordinal === index + 1),
      "PLAN_CRITERIA_ORDER");
    requireCondition(criteria.some((criterion) => criterion.required),
      "PLAN_REQUIRED_CRITERION_MISSING");
    criteria.forEach((criterion) => nonblank(criterion.description));
  } else {
    requireCondition(node.task.taskId !== rootTaskId, "PLAN_ROOT_IS_NODE");
  }
  unique(node.inputs, "slotKey", "PLAN_DUPLICATE_INPUT");
  unique(node.outputs, "slotKey", "PLAN_DUPLICATE_OUTPUT");
  unique(node.verificationProfiles, "profileId", "PLAN_DUPLICATE_PROFILE");
  for (const paths of [node.scope.allowedPaths, node.scope.forbiddenPaths]) {
    requireCondition(new Set(paths).size === paths.length, "PLAN_DUPLICATE_PATH");
    paths.forEach(validatePrefix);
  }
  if (node.scope.access === "read_only") {
    requireCondition(node.scope.allowedPaths.length === 0, "PLAN_READ_ONLY_WRITE_SCOPE");
  } else {
    requireCondition(node.scope.allowedPaths.length > 0, "PLAN_WRITE_SCOPE_MISSING");
    requireCondition(node.scope.allowedPaths.some((allowed) =>
      !node.scope.forbiddenPaths.some((forbidden) => forbidden === "." ||
        allowed === forbidden || allowed.startsWith(`${forbidden}/`))),
    "PLAN_WRITE_SCOPE_FULLY_FORBIDDEN");
  }
  if (node.kind === "implementation") {
    requireCondition(node.scope.access === "isolated_write", "PLAN_WRITER_NOT_ISOLATED");
    requireCondition(node.verificationProfiles.some((profile) => profile.required),
      "PLAN_REQUIRED_VERIFICATION_MISSING");
    requireCondition(node.outputs.some((slot) => slot.required &&
      ["patch", "commit"].includes(slot.kind)), "PLAN_CODE_OUTPUT_MISSING");
  } else {
    requireCondition(node.scope.access === "read_only", "PLAN_REVIEWER_WRITE_SCOPE");
  }
}

function normalizeDefinition(definition) {
  const normalized = structuredClone(definition);
  normalized.nodes.sort(by("nodeKey"));
  normalized.edges.sort(by("edgeKey"));
  normalized.externalInputs.sort((a, b) =>
    binaryCompare(a.nodeKey, b.nodeKey) || binaryCompare(a.inputSlot, b.inputSlot)
  );
  normalized.policy.integrationTargets.sort((a, b) =>
    binaryCompare(a.repositoryId, b.repositoryId) || binaryCompare(a.targetRef, b.targetRef)
  );
  normalized.decision.items.sort(by("itemKey"));
  normalized.decision.sources.sort(by("evidenceRefId"));
  normalized.decision.sourceRevisions.sort(by("evidenceRefId"));
  normalized.decision.unresolvedQuestions.sort(by("questionKey"));
  for (const node of normalized.nodes) {
    node.inputs.sort(by("slotKey"));
    node.outputs.sort(by("slotKey"));
    node.verificationProfiles.sort(by("profileId"));
    node.scope.allowedPaths.sort(binaryCompare);
    node.scope.forbiddenPaths.sort(binaryCompare);
    if (node.task.mode === "new") node.task.criteria.sort((a, b) => a.ordinal - b.ordinal);
  }
  for (const edge of normalized.edges) edge.bindings.sort(by("inputSlot"));
  return normalized;
}

export function validateExecutionPlanDefinition(value) {
  assertExecutionCommand("planDefinition", value);
  nonblank(value.title);
  validateDecision(value.decision);
  unique(value.nodes, "nodeKey", "PLAN_DUPLICATE_NODE");
  unique(value.edges, "edgeKey", "PLAN_DUPLICATE_EDGE");
  const existingTasks = value.nodes.filter((node) => node.task.mode === "existing")
    .map((node) => node.task.taskId);
  requireCondition(new Set(existingTasks).size === existingTasks.length,
    "PLAN_DUPLICATE_TASK");
  requireCondition(value.nodes.some((node) => node.required), "PLAN_REQUIRED_NODE_MISSING");
  requireCondition(value.policy.budget.maxRunAttempts >=
    value.nodes.filter((node) => node.required).length, "PLAN_BUDGET_BELOW_REQUIRED_NODES");
  const nodes = new Map(value.nodes.map((node) => [node.nodeKey, node]));
  const indegree = new Map(value.nodes.map((node) => [node.nodeKey, 0]));
  const outgoing = new Map(value.nodes.map((node) => [node.nodeKey, []]));
  const producers = new Set();
  const pairs = new Set();
  const repositories = new Map();
  const bindings = new Map();
  for (const node of value.nodes) {
    validateNode(node, value.rootTaskId);
    const { repositoryId, bindingId, baseCommit } = node.repository;
    requireCondition(!repositories.has(repositoryId) ||
      repositories.get(repositoryId) === baseCommit, "PLAN_REPOSITORY_BASE_CONFLICT");
    repositories.set(repositoryId, baseCommit);
    requireCondition(!bindings.has(bindingId) || bindings.get(bindingId) === repositoryId,
      "PLAN_REPOSITORY_BINDING_CONFLICT");
    bindings.set(bindingId, repositoryId);
  }
  const bindInput = (node, slotKey, kind) => {
    const slot = node?.inputs.find((entry) => entry.slotKey === slotKey);
    requireCondition(slot && slot.kind === kind, "PLAN_INPUT_SLOT_MISMATCH");
    const identity = `${node.nodeKey}/${slotKey}`;
    requireCondition(!producers.has(identity), "PLAN_MULTIPLE_INPUT_PRODUCERS");
    producers.add(identity);
  };
  for (const edge of value.edges) {
    const source = nodes.get(edge.fromNodeKey);
    const target = nodes.get(edge.toNodeKey);
    requireCondition(source && target, "PLAN_EDGE_NODE_MISSING");
    requireCondition(source !== target, "PLAN_SELF_EDGE");
    const pair = `${edge.fromNodeKey}/${edge.toNodeKey}`;
    requireCondition(!pairs.has(pair), "PLAN_DUPLICATE_EDGE_PAIR");
    pairs.add(pair);
    if (edge.gate === "verified_output") {
      requireCondition(source.verificationProfiles.some((profile) => profile.required),
        "PLAN_UNVERIFIABLE_EDGE");
    }
    if (edge.gate === "integrated_commit") {
      requireCondition(value.policy.integration !== "reviewed_candidate",
        "PLAN_INTEGRATION_GATE_UNAVAILABLE");
    }
    for (const binding of edge.bindings) {
      const slot = source.outputs.find((entry) => entry.slotKey === binding.outputSlot);
      requireCondition(slot, "PLAN_OUTPUT_SLOT_MISSING");
      const inputSlot = target.inputs.find((entry) => entry.slotKey === binding.inputSlot);
      requireCondition(!inputSlot?.required || slot.required,
        "PLAN_OPTIONAL_REQUIRED_INPUT");
      if (["patch", "commit"].includes(slot.kind)) {
        requireCondition(source.repository.repositoryId === target.repository.repositoryId,
          "PLAN_CROSS_REPOSITORY_CODE_INPUT");
      }
      bindInput(target, binding.inputSlot, slot.kind);
    }
    outgoing.get(source.nodeKey).push(target.nodeKey);
    indegree.set(target.nodeKey, indegree.get(target.nodeKey) + 1);
  }
  for (const input of value.externalInputs) {
    bindInput(nodes.get(input.nodeKey), input.inputSlot, input.kind);
  }
  for (const node of value.nodes) {
    requireCondition(node.inputs.every((slot) => !slot.required ||
      producers.has(`${node.nodeKey}/${slot.slotKey}`)), "PLAN_REQUIRED_INPUT_MISSING");
  }
  const targetKeys = new Set();
  for (const target of value.policy.integrationTargets) {
    const key = `${target.repositoryId}/${target.targetRef}`;
    requireCondition(repositories.has(target.repositoryId) && !targetKeys.has(key),
      "PLAN_INTEGRATION_TARGET_INVALID");
    requireCondition(!target.targetRef.includes("..") &&
      !target.targetRef.includes("//") && !target.targetRef.endsWith("/") &&
      target.targetRef.split("/").every((part) => !part.startsWith(".") &&
        !part.endsWith(".") && !part.toLowerCase().endsWith(".lock")),
    "PLAN_INTEGRATION_TARGET_INVALID");
    requireCondition(target.expectedCommit === repositories.get(target.repositoryId),
      "PLAN_INTEGRATION_BASE_CONFLICT");
    targetKeys.add(key);
  }
  if (value.policy.integration !== "reviewed_candidate") {
    requireCondition([...repositories.keys()].every((repositoryId) =>
      value.policy.integrationTargets.some((target) => target.repositoryId === repositoryId)),
    "PLAN_INTEGRATION_TARGET_MISSING");
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([key]) => key)
    .sort(binaryCompare);
  const topologicalOrder = [];
  while (ready.length) {
    const key = ready.shift();
    topologicalOrder.push(key);
    for (const target of outgoing.get(key).sort(binaryCompare)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(binaryCompare);
      }
    }
  }
  requireCondition(topologicalOrder.length === nodes.size, "PLAN_CYCLE");
  const definition = normalizeDefinition(value);
  return {
    definition,
    topologicalOrder,
    digest: executionOperationDigest(definition),
    approvalBlockers: definition.decision.unresolvedQuestions
      .filter((question) => question.required).map((question) => question.questionKey)
  };
}
