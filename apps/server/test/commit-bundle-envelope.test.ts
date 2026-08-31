import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspectCommitBundleEnvelope } from "../src/artifact/commit-bundle-envelope.js";
import { syntheticCommitBundle } from "./helpers/commit-bundle-fixture.js";

test("commit envelope pins both object formats without claiming object verification", () => {
  for (const objectFormat of ["sha1", "sha256"] as const) {
    const width = objectFormat === "sha1" ? 40 : 64;
    assert.deepEqual(inspectCommitBundleEnvelope(syntheticCommitBundle(objectFormat)), {
      objectFormat, prerequisiteCommit: "a".repeat(width), candidateCommit: "c".repeat(width)
    });
  }
});

test("commit envelope rejects extra identity, capabilities, invalid pack checksums and bounds", () => {
  const source = syntheticCommitBundle();
  const mutate = (before: string, after: string) => Buffer.from(source.toString("latin1").replace(before, after), "latin1");
  const corrupt = Buffer.from(source); corrupt[corrupt.length - 1]! ^= 1;
  const highBit = Buffer.from(source), packOffset = highBit.indexOf("\n\n") + 2;
  highBit[packOffset]! |= 0x80;
  createHash("sha1").update(highBit.subarray(packOffset, -20)).digest().copy(highBit, highBit.length - 20);
  for (const invalid of [
    Buffer.alloc(0), Buffer.alloc((4 << 20) + 1), Buffer.from("x".repeat(513) + "\n\nPACK"),
    mutate("# v3", "# v2"), mutate("@object-format=sha1", "@object-format=sha256"),
    mutate("@object-format=sha1\n", "@object-format=sha1\n@filter=blob:none\n"),
    mutate("ConveneWire prepared base", "source subject"),
    mutate("c".repeat(40), "a".repeat(40)), mutate("c".repeat(40), "c".repeat(7)),
    mutate("refs/heads/codex/capture", "refs/heads/main"),
    mutate("\n\nPACK", "\n" + "d".repeat(40) + " refs/heads/other\n\nPACK"),
    corrupt, highBit, source.subarray(0, -1)
  ]) assert.throws(() => inspectCommitBundleEnvelope(invalid), /envelope/u);
});
