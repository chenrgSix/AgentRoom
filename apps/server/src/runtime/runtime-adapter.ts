export type RuntimeStatus =
  | "delivered"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
  | "expired"
  | "outcome_unknown";

export interface RuntimeRequest {
  runId: string;
  taskId: string;
  agentId: string;
  instruction: string;
  contextCursor: number;
  contextPlan?: {
    roomMemory: RuntimeContextMemoryProjection;
    taskMemory: RuntimeContextMemoryProjection;
    resultEvidence?: {
      revision: number;
      deliveryKind?: "bootstrap" | "delta";
      fromRevision?: number;
      throughRevision?: number;
      hasMore?: boolean;
      artifactRefs: RuntimeContextArtifactRef[];
    };
    longTermMemory?: {
      room?: RuntimeLongTermMemoryScope;
      task?: RuntimeLongTermMemoryScope;
    };
  };
  contextMessages: Array<{
    messageId: string;
    sequence: number;
    senderId: string;
    content: string;
  }>;
}

export interface RuntimeContextMemoryProjection {
  summary: string;
  sourceCursor: number;
  revision: number;
  sourceMessageIds: string[];
}

export interface RuntimeContextArtifactRef {
  artifactId: string;
  artifactRevision?: number;
  type: "commit" | "branch" | "file" | "patch" | "test_result" | "document";
  relations?: Array<{
    relationId: string;
    type: "derives_from" | "reviews" | "verifies";
    targetArtifactId: string;
  }>;
  workspaceRef?: string;
  repository?: string;
  path?: string;
  commitSha?: string;
  branch?: string;
  title: string;
  summary: string;
  sourceRunId?: string;
  createdByMemberId?: string;
  createdByAgentId?: string;
  createdAt: string;
}

export interface RuntimeLongTermMemoryScope {
  revision: number;
  activeComplete: boolean;
  entries: Array<{
    memoryId: string;
    type:
      | "decision" | "constraint" | "fact" | "open_question" | "convention"
      | "goal" | "acceptance_criterion" | "plan" | "progress" | "blocker"
      | "result";
    content: string;
    state: "active" | "superseded" | "retracted";
    revision: number;
    supersedesMemoryId?: string;
    sourceMessageIds: string[];
    sourceArtifactIds: string[];
    sourceRunIds: string[];
    sourceDiscussionIds: string[];
  }>;
}

export interface RuntimeRoomContextConsumption {
  baseContextCursor: number;
  checkpointId?: string;
  rawFromSequenceExclusive: number;
  rawThroughSequenceInclusive: number;
  rawMessageCount: number;
  coverageThroughSequence: number;
}

export interface RuntimeTaskClarification {
  kind: "task";
  question: string;
  choices?: string[];
}

export type RuntimeEvent =
  | {
      type: "status";
      sequence: number;
      status: RuntimeStatus;
      error?: {
        code: string;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
      session?: {
        disposition: "started" | "resumed" | "recreated";
        contextCursor: number;
        runtimeScopeId?: string;
        resultEvidenceRevision?: number;
        roomContextConsumption?: RuntimeRoomContextConsumption;
      };
      clarification?: RuntimeTaskClarification;
    }
  | {
      type: "activity";
      sequence: number;
      activityId: string;
      kind: "reasoning" | "tool";
      phase: "started" | "updated" | "completed" | "failed";
      label?: string;
      content?: string;
      reset?: boolean;
    }
  | {
      type: "output";
      sequence: number;
      content: string;
      reset?: boolean;
    }
  | {
      type: "reply";
      sequence: number;
      content: string;
      assessment?: Record<string, unknown>;
    };

export interface RuntimeAdapter {
  execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent>;
}
