import type {
  AcceptedExecutionNodeMaterialization,
  VerifiedExecutionNodeMaterialization
} from "../execution-node-materialization-repository.js";
import type { ExecutionNodeIdentity } from
  "../execution-node-state-repository.js";
import type { AcceptedResultMaterializer } from
  "./accepted-result-materializer.js";
import type { VerifiedOutputMaterializer } from
  "./verified-output-materializer.js";

export interface ReconciledExecutionMaterializations {
  accepted: AcceptedExecutionNodeMaterialization | undefined;
  verified: VerifiedExecutionNodeMaterialization | undefined;
}

/** Converts retained evidence into gate proof; it never projects Run state. */
export class ExecutionMaterializationService {
  public constructor(
    private readonly accepted: AcceptedResultMaterializer,
    private readonly verified: VerifiedOutputMaterializer
  ) {}

  public reconcileOne(
    identity: ExecutionNodeIdentity
  ): ReconciledExecutionMaterializations {
    return {
      accepted: this.accepted.reconcile(identity),
      verified: this.verified.reconcile(identity)
    };
  }
}
