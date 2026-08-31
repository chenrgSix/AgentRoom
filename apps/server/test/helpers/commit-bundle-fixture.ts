import { createHash } from "node:crypto";

// Deliberately synthetic pack: valid only for envelope/transport tests. Actual
// object validity is established by repository-capture-go.test.ts with real Git.
export function syntheticCommitBundle(format: "sha1" | "sha256" = "sha1", prerequisite?: string): Buffer {
  const width = format === "sha1" ? 40 : 64;
  const pack = Buffer.alloc(13 + width / 2);
  pack.write("PACK"); pack.writeUInt32BE(2, 4); pack.writeUInt32BE(1, 8);
  createHash(format).update(pack.subarray(0, -width / 2)).digest().copy(pack, 13);
  return Buffer.concat([Buffer.from(`# v3 git bundle\n@object-format=${format}\n-${prerequisite ?? "a".repeat(width)} ConveneWire prepared base\n${"c".repeat(width)} refs/heads/codex/capture\n\n`), pack]);
}
