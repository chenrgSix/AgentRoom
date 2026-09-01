import type { RunState } from "../run/run-repository.js";
import {
  type ExecutionNodeIdentity,
  type ExecutionNodeState,
  type ExecutionNodeStateRepository,
  type ExecutionNodeStateValue
} from "./execution-node-state-repository.js";

export interface ExecutionRunProjection extends ExecutionNodeIdentity {
  blockerCode: string | null;
  dispatchGeneration: number | null;
  lastRunState: RunState | null;
  runId: string | null;
  state: ExecutionNodeStateValue;
}

/** Sole application mutation path for the ExecutionNodeState projection. */
export class ExecutionNodeProjector {
  public constructor(private readonly nodes: ExecutionNodeStateRepository) {}

  public ensureCurrent(now: string): void {
    this.nodes.ensureCurrent(now);
  }

  public get(identity: ExecutionNodeIdentity): ExecutionNodeState | undefined {
    return this.nodes.get(identity);
  }

  public listAllCurrent(): ExecutionNodeIdentity[] {
    return this.nodes.listAllCurrent();
  }

  public projectReadiness(
    identity: ExecutionNodeIdentity,
    readiness:
      | { ready: true; blocker: null }
      | { ready: false; blocker: string },
    now: string
  ): ExecutionNodeState {
    return this.nodes.writeProjection({
      ...identity,
      state: readiness.ready ? "ready" : "blocked",
      blockerCode: readiness.blocker,
      dispatchGeneration: null,
      runId: null,
      lastRunState: null,
      updatedAt: now
    });
  }

  public projectRunSettlement(
    input: ExecutionRunProjection,
    now: string
  ): ExecutionNodeState {
    return this.nodes.writeProjection({ ...input, updatedAt: now });
  }
}
