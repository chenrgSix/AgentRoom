import { createHash } from "node:crypto";

/** Closed transport envelope, not a claim that Git objects or tests are valid. */
export function inspectCommitBundleEnvelope(bytes: Buffer): {
  objectFormat: "sha1" | "sha256";
  prerequisiteCommit: string;
  candidateCommit: string;
} {
  const invalid = (): never => { throw new Error("Commit bundle envelope is invalid"); };
  if (bytes.length > 4 << 20) return invalid();
  const end = bytes.indexOf("\n\n");
  if (end < 0 || end > 512) return invalid();
  const lines = bytes.subarray(0, end).toString("utf8").split("\n");
  if (lines.length !== 4 || lines[0] !== "# v3 git bundle") return invalid();
  const objectFormat = lines[1] === "@object-format=sha1" ? "sha1"
    : lines[1] === "@object-format=sha256" ? "sha256" : invalid();
  const width = objectFormat === "sha1" ? 40 : 64;
  const prerequisite = new RegExp(`^-([0-9a-f]{${width}}) ConveneWire prepared base$`, "u").exec(lines[2]!);
  const candidate = new RegExp(`^([0-9a-f]{${width}}) refs/heads/codex/capture$`, "u").exec(lines[3]!);
  if (!prerequisite || !candidate || prerequisite[1] === candidate[1]) return invalid();
  const pack = bytes.subarray(end + 2), hashBytes = width / 2;
  if (pack.length <= 12 + hashBytes || !pack.subarray(0, 4).equals(Buffer.from("PACK")) ||
    pack.readUInt32BE(4) !== 2 || pack.readUInt32BE(8) === 0 ||
    !createHash(objectFormat).update(pack.subarray(0, -hashBytes)).digest().equals(pack.subarray(-hashBytes))) {
    return invalid();
  }
  return { objectFormat, prerequisiteCommit: prerequisite[1]!, candidateCommit: candidate[1]! };
}
