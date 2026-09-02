import assert from "node:assert/strict";
import test from "node:test";

import { remoteEvidenceNeedsInputAttestation } from
  "../src/remote/remote-evidence-adoption-service.js";

test("remote evidence remains fail closed until every declared input is attested", () => {
  const definition = {
    nodes: [
      { nodeKey: "Root", inputs: [] },
      { nodeKey: "Dependent", inputs: [{ slotKey: "source" }] }
    ]
  };

  assert.equal(remoteEvidenceNeedsInputAttestation(definition, "Root"), false);
  assert.equal(remoteEvidenceNeedsInputAttestation(definition, "Dependent"), true);
  assert.equal(remoteEvidenceNeedsInputAttestation(definition, "Missing"), true);
});
