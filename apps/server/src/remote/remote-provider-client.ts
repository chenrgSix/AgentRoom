import type {
  ProviderCIObservation,
  ProviderCommitObservation,
  RemoteProviderBinding
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";
import {
  createRemoteProviderEgressFetch,
  RemoteProviderEgressError
} from "./remote-provider-egress-policy.js";

const jsonLimit = 128 * 1024;
const bundleLimit = 4 * 1024 * 1024;
const defaultTimeoutMilliseconds = 15_000;

export type RemoteProviderCredentialResolver = (
  providerBindingId: string
) => Promise<string | undefined> | string | undefined;

export class RemoteProviderClientError extends Error {
  public constructor(
    public readonly code: string,
    public readonly outcomeUnknown = false
  ) {
    super(code);
    this.name = "RemoteProviderClientError";
  }
}

export interface RemoteCommitObservationRequest {
  operationId: string;
  providerRepositoryId: string;
  baseCommit: string;
  commit: string;
}

export interface RemoteCIObservationRequest {
  operationId: string;
  providerRepositoryId: string;
  checkKey: string;
  attempt: number;
  commit: string;
  tree: string;
}

function requireCredential(value: string | undefined): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RemoteProviderClientError("REMOTE_PROVIDER_CREDENTIAL_UNAVAILABLE");
  }
  return value;
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new RemoteProviderClientError("REMOTE_PROVIDER_RESPONSE_INVALID");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new RemoteProviderClientError("REMOTE_PROVIDER_RESPONSE_TOO_LARGE");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RemoteProviderClientError("REMOTE_PROVIDER_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== size) {
    throw new RemoteProviderClientError("REMOTE_PROVIDER_RESPONSE_TRUNCATED");
  }
  return Buffer.concat(chunks, size);
}

function requireContentType(response: Response, expected: string): void {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== expected) {
    throw new RemoteProviderClientError("REMOTE_PROVIDER_CONTENT_TYPE_INVALID");
  }
}

async function parseJSON<T>(
  response: Response,
  kind: "providerCommitObservation" | "providerCIObservation"
): Promise<T> {
  requireContentType(response, "application/json");
  let value: unknown;
  try {
    value = JSON.parse((await readBounded(response, jsonLimit)).toString("utf8"));
    assertExecutionCommand(kind, value);
  } catch (error) {
    if (error instanceof RemoteProviderClientError) throw error;
    throw new RemoteProviderClientError("REMOTE_PROVIDER_RESPONSE_INVALID");
  }
  return value as T;
}

/** Authenticated provider-neutral HTTP reader. It never stores or logs credentials. */
export class RemoteProviderClient {
  public constructor(
    private readonly resolveCredential: RemoteProviderCredentialResolver,
    private readonly providerFetch: typeof fetch = createRemoteProviderEgressFetch(),
    private readonly timeoutMilliseconds = defaultTimeoutMilliseconds
  ) {
    if (!Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds < 1 || timeoutMilliseconds > 60_000) {
      throw new Error(
        "Remote provider timeout must be between 1 and 60000 milliseconds"
      );
    }
  }

  public async observeCommit(
    binding: RemoteProviderBinding,
    request: RemoteCommitObservationRequest
  ): Promise<{ observation: ProviderCommitObservation; bundle: Buffer }> {
    return this.withTimeout(async (signal) => {
      const observation = await this.lookupOrCreate<ProviderCommitObservation>(
        binding,
        "commit-observations",
        request,
        "providerCommitObservation",
        signal
      );
      const bundleURL = new URL(
        `/v1/commit-observations/${encodeURIComponent(observation.observationId)}/bundle`,
        binding.providerOrigin
      );
      const response = await this.call(
        binding, bundleURL, { method: "GET" }, signal
      );
      if (!response.ok) {
        throw new RemoteProviderClientError("REMOTE_PROVIDER_BUNDLE_UNAVAILABLE");
      }
      requireContentType(response, "application/x-git-bundle");
      return { observation, bundle: await readBounded(response, bundleLimit) };
    });
  }

  public async observeCI(
    binding: RemoteProviderBinding,
    request: RemoteCIObservationRequest
  ): Promise<ProviderCIObservation> {
    return this.withTimeout((signal) => this.lookupOrCreate<ProviderCIObservation>(
      binding,
      "ci-observations",
      request,
      "providerCIObservation",
      signal
    ));
  }

  private async lookupOrCreate<T>(
    binding: RemoteProviderBinding,
    resource: "commit-observations" | "ci-observations",
    request: RemoteCommitObservationRequest | RemoteCIObservationRequest,
    kind: "providerCommitObservation" | "providerCIObservation",
    signal: AbortSignal
  ): Promise<T> {
    const lookup = new URL(
      `/v1/${resource}/${encodeURIComponent(request.operationId)}`,
      binding.providerOrigin
    );
    const found = await this.call(binding, lookup, { method: "GET" }, signal);
    if (found.ok) return parseJSON<T>(found, kind);
    if (found.status !== 404) {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_LOOKUP_FAILED");
    }
    const create = new URL(`/v1/${resource}`, binding.providerOrigin);
    let response: Response;
    try {
      response = await this.call(binding, create, {
        method: "POST",
        body: canonicalExecutionJSON(request)
      }, signal);
    } catch (error) {
      if (error instanceof RemoteProviderClientError &&
        error.code === "REMOTE_PROVIDER_CREDENTIAL_UNAVAILABLE") throw error;
      throw new RemoteProviderClientError("REMOTE_PROVIDER_OUTCOME_UNKNOWN", true);
    }
    if (!response.ok) {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_OUTCOME_UNKNOWN", true);
    }
    return parseJSON<T>(response, kind);
  }

  private async call(
    binding: RemoteProviderBinding,
    url: URL,
    init: { method: "GET" | "POST"; body?: string },
    signal: AbortSignal
  ): Promise<Response> {
    const token = requireCredential(await this.resolveCredential(
      binding.providerBindingId
    ));
    let response: Response;
    try {
      response = await this.providerFetch(url, {
        method: init.method,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json, application/x-git-bundle",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {})
        }
      });
    } catch (error) {
      if (signal.aborted) {
        throw new RemoteProviderClientError("REMOTE_PROVIDER_TIMEOUT");
      }
      if (error instanceof RemoteProviderEgressError) {
        throw new RemoteProviderClientError(error.code);
      }
      throw new RemoteProviderClientError("REMOTE_PROVIDER_UNAVAILABLE");
    }
    if (response.status >= 300 && response.status < 400) {
      throw new RemoteProviderClientError("REMOTE_PROVIDER_REDIRECT_REJECTED");
    }
    return response;
  }

  private async withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RemoteProviderClientError("REMOTE_PROVIDER_TIMEOUT"));
      }, this.timeoutMilliseconds);
    });
    try {
      return await Promise.race([operation(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
