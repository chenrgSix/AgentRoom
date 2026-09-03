import type Database from "better-sqlite3";
import type {
  ExecutionPlanDefinition,
  RemoteInputAttestation
} from "@convene-wire/contracts/execution-plan";
import { remoteInputEvidenceDigest } from
  "@convene-wire/contracts/execution-validation";
import type { LocalArtifactBlobStore } from
  "../artifact/local-artifact-blob-store.js";
import { ExecutionNodeMaterializationRepository } from
  "../execution/execution-node-materialization-repository.js";

type PlannedInput = RemoteInputAttestation["inputs"][number];
type PlanNode = ExecutionPlanDefinition["nodes"][number];

interface ArtifactRow {
  artifact_revision: number;
  artifact_type: string;
  content_mode: string;
  content_sha256: string | null;
  size_bytes: number;
  storage_key: string;
}

export class RemoteInputPlanError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "RemoteInputPlanError";
  }
}

const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const reject = (code = "REMOTE_INPUT_ATTESTATION_UNAVAILABLE"): never => {
  throw new RemoteInputPlanError(code);
};

export function remoteInputTopologySupported(
  definition: ExecutionPlanDefinition,
  nodeKey: string
): boolean {
  const node = definition.nodes.find((entry) => entry.nodeKey === nodeKey);
  if (!node || definition.externalInputs.some((entry) =>
    entry.nodeKey === nodeKey)) return false;
  if (node.inputs.length === 0) {
    return !definition.edges.some((edge) => edge.toNodeKey === nodeKey);
  }
  if (node.inputs.some((input) => !input.required)) return false;
  return node.inputs.every((input) => definition.edges.reduce(
    (count, edge) => count + (edge.toNodeKey === nodeKey
      ? edge.bindings.filter((binding) =>
        binding.inputSlot === input.slotKey).length
      : 0),
    0
  ) === 1) && definition.edges.filter((edge) =>
    edge.toNodeKey === nodeKey).every((edge) => edge.bindings.length > 0);
}

/** Resolves only retained adoptions and sealed bytes; graph ancestry is never
 * accepted as a substitute for explicit input evidence. */
export class RemoteInputAttestationPlanner {
  private readonly materializations: ExecutionNodeMaterializationRepository;

  public constructor(
    private readonly database: Database.Database,
    private readonly blobs: LocalArtifactBlobStore
  ) {
    this.materializations = new ExecutionNodeMaterializationRepository(database);
  }

  public plan(
    definition: ExecutionPlanDefinition,
    planId: string,
    planRevision: number,
    nodeKey: string
  ): {
    inputs: RemoteInputAttestation["inputs"];
    remoteInputEvidenceDigest: string;
  } {
    if (!remoteInputTopologySupported(definition, nodeKey)) reject();
    const node = definition.nodes.find((entry) => entry.nodeKey === nodeKey)!;
    if (node.inputs.length === 0) reject("REMOTE_INPUT_ATTESTATION_NOT_REQUIRED");
    const inputs = node.inputs.map((input): PlannedInput => {
      const matches = definition.edges.flatMap((edge) =>
        edge.toNodeKey !== nodeKey ? [] : edge.bindings
          .filter((binding) => binding.inputSlot === input.slotKey)
          .map((binding) => ({ edge, binding })));
      if (matches.length !== 1) return reject();
      const { edge, binding } = matches[0]!;
      const materialization = this.materializations.getAdopted({
        planId,
        planRevision,
        nodeKey: edge.fromNodeKey
      }, edge.gate);
      if (!materialization) return reject("REMOTE_INPUT_ADOPTION_MISSING");
      const pin = materialization.artifactPins.find((entry) =>
        entry.outputSlot === binding.outputSlot);
      if (!pin || pin.kind !== input.kind) return reject();
      const artifact = this.database.prepare(`
        SELECT ref.artifact_revision, ref.artifact_type, ref.content_mode,
          ref.content_sha256, content.size_bytes, content.storage_key
        FROM task_artifact_refs ref
        JOIN artifact_contents content ON content.content_id = ref.content_id
        WHERE ref.artifact_id = ?
      `).get(pin.artifactId) as ArtifactRow | undefined;
      if (!artifact || artifact.artifact_revision !== pin.artifactRevision ||
        artifact.artifact_type !== pin.kind ||
        artifact.content_mode !== "snapshot_blob" ||
        artifact.content_sha256 !== pin.contentDigest ||
        artifact.size_bytes !== pin.byteLength) return reject();
      try {
        this.blobs.readVerified(
          artifact.storage_key,
          pin.contentDigest,
          pin.byteLength
        );
      } catch {
        return reject("REMOTE_INPUT_ARTIFACT_INVALID");
      }
      const proofRows = this.database.prepare(`
        SELECT proof_set_digest FROM execution_evidence_adoptions
        WHERE adoption_id = ? AND adoption_digest = ?
        UNION ALL
        SELECT proof_set_digest FROM execution_remote_evidence_adoptions
        WHERE adoption_id = ? AND adoption_digest = ?
      `).all(
        materialization.adoptionId,
        materialization.adoptionDigest,
        materialization.adoptionId,
        materialization.adoptionDigest
      ) as Array<{ proof_set_digest: string }>;
      if (proofRows.length !== 1) return reject();
      return {
        adoptionId: materialization.adoptionId,
        adoptionDigest: materialization.adoptionDigest,
        reuseInput: {
          inputSlot: input.slotKey,
          producer: {
            kind: "adopted_evidence",
            edge: structuredClone(edge),
            sourceEvidenceId: materialization.sourceEvidenceId,
            sourceDigest: materialization.sourceDigest,
            proofSetDigest: proofRows[0]!.proof_set_digest
          },
          artifact: {
            kind: pin.kind,
            contentDigest: pin.contentDigest
          }
        }
      };
    }).sort((left, right) => binary(
      left.reuseInput.inputSlot,
      right.reuseInput.inputSlot
    )) as RemoteInputAttestation["inputs"];
    return { inputs, remoteInputEvidenceDigest: remoteInputEvidenceDigest(inputs) };
  }
}
