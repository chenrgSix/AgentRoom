export type RuntimeStatus =
  | "delivered"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export interface RuntimeRequest {
  runId: string;
  agentId: string;
  instruction: string;
  contextMessages: Array<{
    messageId: string;
    senderId: string;
    content: string;
  }>;
}

export type RuntimeEvent =
  | {
      type: "status";
      sequence: number;
      status: RuntimeStatus;
      error?: { code: string; message: string; retryable: boolean };
    }
  | {
      type: "reply";
      sequence: number;
      content: string;
    };

export interface RuntimeAdapter {
  execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent>;
}
