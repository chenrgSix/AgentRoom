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
  contextMessages: Array<{
    messageId: string;
    sequence: number;
    senderId: string;
    content: string;
  }>;
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
      };
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
