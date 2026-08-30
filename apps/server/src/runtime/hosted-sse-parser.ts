export type HostedSseParserErrorCode =
  | "HOSTED_SSE_INVALID_UTF8"
  | "HOSTED_SSE_EVENT_TOO_LARGE"
  | "HOSTED_SSE_STREAM_TOO_LARGE"
  | "HOSTED_SSE_INCOMPLETE_EVENT";

export class HostedSseParserError extends Error {
  public override readonly name = "HostedSseParserError";

  public constructor(
    public readonly code: HostedSseParserErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface HostedServerSentEvent {
  event?: string;
  data: string;
}

export interface HostedSseParserLimits {
  maxEventBytes?: number;
  maxStreamBytes?: number;
}

const defaultMaxEventBytes = 256 * 1024;
const defaultMaxStreamBytes = 2 * 1024 * 1024;
const eventDelimiter = /\r\n\r\n|\n\n|\r\r/u;
const lineDelimiter = /\r\n|\n|\r/u;

function positiveLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseEventFrame(frame: string): HostedServerSentEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(lineDelimiter)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) return undefined;
  return {
    ...(event ? { event } : {}),
    data: data.join("\n")
  };
}

/**
 * Parse a bounded UTF-8 Server-Sent Events stream without retaining raw
 * provider frames after each event is yielded.
 */
export async function* parseHostedServerSentEvents(
  stream: ReadableStream<Uint8Array>,
  limits: HostedSseParserLimits = {}
): AsyncIterable<HostedServerSentEvent> {
  const maxEventBytes = positiveLimit(
    limits.maxEventBytes,
    defaultMaxEventBytes,
    "Hosted SSE event limit"
  );
  const maxStreamBytes = positiveLimit(
    limits.maxStreamBytes,
    defaultMaxStreamBytes,
    "Hosted SSE stream limit"
  );
  if (maxEventBytes > maxStreamBytes) {
    throw new Error("Hosted SSE event limit cannot exceed the stream limit");
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let totalBytes = 0;
  let reachedEnd = false;

  const decoded = (chunk?: Uint8Array): string => {
    try {
      return chunk
        ? decoder.decode(chunk, { stream: true })
        : decoder.decode();
    } catch {
      throw new HostedSseParserError(
        "HOSTED_SSE_INVALID_UTF8",
        "Hosted provider stream is not valid UTF-8."
      );
    }
  };

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        reachedEnd = true;
        buffered += decoded();
      } else {
        totalBytes += result.value.byteLength;
        if (totalBytes > maxStreamBytes) {
          throw new HostedSseParserError(
            "HOSTED_SSE_STREAM_TOO_LARGE",
            "Hosted provider stream exceeded its byte limit."
          );
        }
        buffered += decoded(result.value);
      }

      while (true) {
        const match = eventDelimiter.exec(buffered);
        if (!match || match.index === undefined) break;
        const frame = buffered.slice(0, match.index);
        buffered = buffered.slice(match.index + match[0].length);
        if (utf8Bytes(frame) > maxEventBytes) {
          throw new HostedSseParserError(
            "HOSTED_SSE_EVENT_TOO_LARGE",
            "Hosted provider event exceeded its byte limit."
          );
        }
        const event = parseEventFrame(frame);
        if (event) yield event;
      }

      if (utf8Bytes(buffered) > maxEventBytes) {
        throw new HostedSseParserError(
          "HOSTED_SSE_EVENT_TOO_LARGE",
          "Hosted provider event exceeded its byte limit."
        );
      }
      if (reachedEnd) break;
    }

    if (buffered.trim().length > 0) {
      throw new HostedSseParserError(
        "HOSTED_SSE_INCOMPLETE_EVENT",
        "Hosted provider stream ended inside an event."
      );
    }
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {
        // A transport or AbortSignal may already have closed the stream.
      }
    }
    reader.releaseLock();
  }
}
