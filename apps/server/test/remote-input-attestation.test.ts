import assert from "node:assert/strict";
import test from "node:test";

import { remoteInputTopologySupported } from
  "../src/remote/remote-input-attestation-planner.js";

const input = (slotKey: string, required = true) => ({
  slotKey,
  kind: "patch" as const,
  required
});
const edge = (inputSlot: string, bindings = [{
  inputSlot,
  outputSlot: "output"
}]) => ({
  edgeKey: `edge_${inputSlot}`,
  fromNodeKey: "Root",
  toNodeKey: "Dependent",
  gate: "verified_output" as const,
  bindings
});

test("remote input topology rejects missing, optional, external and ambiguous inputs", () => {
  const definition = {
    externalInputs: [],
    edges: [edge("source")],
    nodes: [
      { nodeKey: "Root", inputs: [] },
      { nodeKey: "Dependent", inputs: [input("source")] }
    ]
  } as Parameters<typeof remoteInputTopologySupported>[0];

  assert.equal(remoteInputTopologySupported(definition, "Root"), true);
  assert.equal(remoteInputTopologySupported(definition, "Dependent"), true);
  assert.equal(remoteInputTopologySupported(definition, "Missing"), false);
  assert.equal(remoteInputTopologySupported({
    ...definition,
    edges: []
  }, "Dependent"), false);
  assert.equal(remoteInputTopologySupported({
    ...definition,
    nodes: definition.nodes.map((node) => node.nodeKey === "Dependent"
      ? { ...node, inputs: [input("source", false)] }
      : node)
  }, "Dependent"), false);
  assert.equal(remoteInputTopologySupported({
    ...definition,
    externalInputs: [{
      nodeKey: "Dependent",
      inputSlot: "source",
      sourceTaskId: "task_source0001",
      sourceResultId: "result_source0001",
      artifactId: "artifact_source0001",
      artifactRevision: 1,
      contentDigest: "a".repeat(64),
      kind: "patch"
    }]
  }, "Dependent"), false);
  assert.equal(remoteInputTopologySupported({
    ...definition,
    edges: [edge("source"), { ...edge("source"), edgeKey: "edge_duplicate" }]
  }, "Dependent"), false);
  assert.equal(remoteInputTopologySupported({
    ...definition,
    edges: [{ ...edge("source"), bindings: [] }]
  }, "Dependent"), false);
});
