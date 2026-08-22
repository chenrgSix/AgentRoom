import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeRequest
} from "./runtime-adapter.js";

export interface FakeRuntimeScript {
  expectedInstruction?: string;
  events: RuntimeEvent[];
}

const terminalStatuses = new Set([
  "completed",
  "failed",
  "canceled",
  "outcome_unknown"
]);

function validateScript(script: FakeRuntimeScript): void {
  let lastSequence = 0;
  let terminal = false;
  for (const event of script.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
      throw new Error("Fake Runtime event sequence must strictly increase");
    }
    if (terminal) {
      throw new Error("Fake Runtime script cannot emit after a terminal status");
    }
    lastSequence = event.sequence;
    if (event.type === "status" && terminalStatuses.has(event.status)) {
      terminal = true;
    }
  }
  if (!terminal) {
    throw new Error("Fake Runtime script must contain a terminal status");
  }
}

export class FakeRuntimeAdapter implements RuntimeAdapter {
  private readonly scripts: FakeRuntimeScript[] = [];
  private readonly requests: RuntimeRequest[] = [];

  public enqueue(script: FakeRuntimeScript): void {
    validateScript(script);
    this.scripts.push(structuredClone(script));
  }

  public receivedRequests(): RuntimeRequest[] {
    return structuredClone(this.requests);
  }

  public async *execute(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift();
    if (!script) {
      throw new Error("Fake Runtime has no queued script");
    }
    if (
      script.expectedInstruction !== undefined &&
      script.expectedInstruction !== request.instruction
    ) {
      throw new Error("Fake Runtime received an unexpected instruction");
    }
    this.requests.push(structuredClone(request));
    for (const event of script.events) {
      await Promise.resolve();
      yield structuredClone(event);
    }
  }
}
