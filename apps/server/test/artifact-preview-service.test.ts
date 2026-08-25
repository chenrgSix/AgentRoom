import assert from "node:assert/strict";
import test from "node:test";

import { boundedUtf8ArtifactPreview } from
  "../src/artifact/artifact-preview-service.js";

test("Artifact preview is UTF-8-only and bounded before browser delivery", () => {
  const source = `${"a".repeat(199_999)}你好`;
  const preview = boundedUtf8ArtifactPreview(Buffer.from(source, "utf8"));
  assert.equal(preview.text.length, 200_000);
  assert.equal(preview.text.endsWith("你"), true);
  assert.equal(preview.truncated, true);
  assert.throws(
    () => boundedUtf8ArtifactPreview(Buffer.from([0xc3, 0x28])),
    /valid UTF-8/u
  );
});
