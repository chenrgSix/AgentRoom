import { lookup as systemLookup } from "node:dns/promises";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type RequestOptions
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import {
  BlockList,
  connect as connectTCP,
  isIP,
  type Socket
} from "node:net";
import { Readable } from "node:stream";
import {
  connect as connectTLS,
  type ConnectionOptions,
  type TLSSocket
} from "node:tls";

export type RemoteProviderAddressFamily = 4 | 6;

export interface RemoteProviderResolvedAddress {
  address: string;
  family: RemoteProviderAddressFamily;
}

export type RemoteProviderLookup = (
  hostname: string
) => Promise<readonly RemoteProviderResolvedAddress[]>;

export type RemoteProviderEgressErrorCode =
  | "REMOTE_PROVIDER_EGRESS_DENIED"
  | "REMOTE_PROVIDER_DNS_UNAVAILABLE"
  | "REMOTE_PROVIDER_CONNECTION_MISMATCH"
  | "REMOTE_PROVIDER_REDIRECT_REJECTED"
  | "REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE";

export class RemoteProviderEgressError extends Error {
  public constructor(public readonly code: RemoteProviderEgressErrorCode) {
    super(code);
    this.name = "RemoteProviderEgressError";
  }
}

export interface RemoteProviderEgressFetchOptions {
  lookup?: RemoteProviderLookup;
  /** Isolated deterministic tests only; this capability is never read from runtime config. */
  testOnlyAllowLoopback?: boolean;
  /** Test CA material is accepted only together with the loopback test capability. */
  testOnlyTLSCA?: string | Buffer;
}

const blockedAddresses = new BlockList();
const loopbackAddresses = new BlockList();
const testLoopbackFetches = new WeakSet<typeof fetch>();

function addSubnet(
  address: string,
  prefix: number,
  family: "ipv4" | "ipv6"
): void {
  blockedAddresses.addSubnet(address, prefix, family);
}

for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) addSubnet(address, prefix, "ipv4");

for (const [address, prefix] of [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
] as const) addSubnet(address, prefix, "ipv6");

for (const address of ["100.100.100.200", "168.63.129.16"] as const) {
  blockedAddresses.addAddress(address, "ipv4");
}

loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

function familyName(family: RemoteProviderAddressFamily): "ipv4" | "ipv6" {
  return family === 4 ? "ipv4" : "ipv6";
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function requireAddressFamily(
  address: string,
  family: number
): RemoteProviderAddressFamily {
  const parsedFamily = isIP(address);
  if ((family !== 4 && family !== 6) || parsedFamily !== family) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_DNS_UNAVAILABLE");
  }
  return family;
}

function isLoopbackAddress(address: string, family: RemoteProviderAddressFamily): boolean {
  return loopbackAddresses.check(address, familyName(family));
}

export function assertRemoteProviderAddressAllowed(
  resolved: RemoteProviderResolvedAddress,
  testOnlyAllowLoopback = false
): void {
  const family = requireAddressFamily(resolved.address, resolved.family);
  if (
    blockedAddresses.check(resolved.address, familyName(family)) &&
    !(testOnlyAllowLoopback && isLoopbackAddress(resolved.address, family))
  ) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_EGRESS_DENIED");
  }
}

export function assertRemoteProviderConnectedPeer(
  pinned: RemoteProviderResolvedAddress,
  actualAddress: string | undefined
): void {
  if (!actualAddress) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_CONNECTION_MISMATCH");
  }
  const actualFamily = isIP(actualAddress);
  if (actualFamily !== 4 && actualFamily !== 6) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_CONNECTION_MISMATCH");
  }
  const exact = new BlockList();
  exact.addAddress(pinned.address, familyName(pinned.family));
  if (!exact.check(actualAddress, familyName(actualFamily))) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_CONNECTION_MISMATCH");
  }
}

async function defaultLookup(
  hostname: string
): Promise<readonly RemoteProviderResolvedAddress[]> {
  try {
    const answers = await systemLookup(hostname, { all: true, verbatim: true });
    return answers.map(({ address, family }) => ({
      address,
      family: requireAddressFamily(address, family)
    }));
  } catch (error) {
    if (error instanceof RemoteProviderEgressError) throw error;
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_DNS_UNAVAILABLE");
  }
}

export async function resolveAndPinRemoteProviderAddress(
  url: URL,
  lookup: RemoteProviderLookup = defaultLookup,
  testOnlyAllowLoopback = false
): Promise<RemoteProviderResolvedAddress> {
  const hostname = hostnameWithoutBrackets(url.hostname);
  const literalFamily = isIP(hostname);
  let answers: readonly RemoteProviderResolvedAddress[];
  if (literalFamily === 4 || literalFamily === 6) {
    answers = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      answers = await lookup(hostname);
    } catch (error) {
      if (error instanceof RemoteProviderEgressError) throw error;
      throw new RemoteProviderEgressError("REMOTE_PROVIDER_DNS_UNAVAILABLE");
    }
  }
  if (answers.length === 0) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_DNS_UNAVAILABLE");
  }
  for (const answer of answers) {
    assertRemoteProviderAddressAllowed(answer, testOnlyAllowLoopback);
  }
  return { ...answers[0]! };
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

function noResponseBody(method: string, status: number): boolean {
  return method === "HEAD" || status === 204 || status === 205 || status === 304;
}

function transportError(error: unknown): RemoteProviderEgressError {
  return error instanceof RemoteProviderEgressError
    ? error
    : new RemoteProviderEgressError("REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE");
}

function requestPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

class PinnedHttpAgent extends HttpAgent {
  public constructor(private readonly pinnedSocket: Socket) {
    super({ keepAlive: false });
  }

  public override createConnection(): Socket {
    return this.pinnedSocket;
  }
}

class PinnedHttpsAgent extends HttpsAgent {
  public constructor(private readonly pinnedSocket: TLSSocket) {
    super({ keepAlive: false, maxCachedSessions: 0 });
  }

  public override createConnection(): TLSSocket {
    return this.pinnedSocket;
  }
}

function connectPinnedSocket(
  url: URL,
  pinned: RemoteProviderResolvedAddress,
  signal: AbortSignal | null | undefined,
  testOnlyTLSCA: string | Buffer | undefined
): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const hostname = hostnameWithoutBrackets(url.hostname);
    let socket: Socket | TLSSocket;
    if (url.protocol === "https:") {
      const tlsOptions: ConnectionOptions = {
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        ...(testOnlyTLSCA === undefined ? {} : { ca: testOnlyTLSCA })
      };
      socket = connectTLS(requestPort(url), pinned.address, tlsOptions);
    } else {
      socket = connectTCP({
        host: pinned.address,
        port: requestPort(url),
        family: pinned.family
      });
    }
    let settled = false;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      socket.off("error", failed);
      socket.off("connect", connected);
      socket.off("secureConnect", secured);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(transportError(error));
    };
    const abort = (): void => fail(
      new RemoteProviderEgressError("REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE")
    );
    const connected = (): void => {
      try {
        assertRemoteProviderConnectedPeer(pinned, socket.remoteAddress);
        if (url.protocol === "http:") succeed();
      } catch (error) {
        fail(error);
      }
    };
    const secured = (): void => succeed();
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // The HTTP client attaches its own listener immediately after this promise.
      socket.on("error", () => undefined);
      resolve(socket);
    };
    const failed = (error: Error): void => fail(error);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", failed);
    socket.once("connect", connected);
    if (url.protocol === "https:") socket.once("secureConnect", secured);
  });
}

async function performRequest(
  url: URL,
  init: RequestInit,
  pinned: RemoteProviderResolvedAddress,
  testOnlyTLSCA: string | Buffer | undefined
): Promise<Response> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  const body = init.body;
  if ((method !== "GET" && method !== "POST") ||
    (body !== undefined && body !== null && typeof body !== "string")) {
    throw new RemoteProviderEgressError("REMOTE_PROVIDER_EGRESS_DENIED");
  }
  const socket = await connectPinnedSocket(
    url, pinned, init.signal, testOnlyTLSCA
  );
  const agent = url.protocol === "https:"
    ? new PinnedHttpsAgent(socket as TLSSocket)
    : new PinnedHttpAgent(socket as Socket);
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: hostnameWithoutBrackets(url.hostname),
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    method,
    headers: Object.fromEntries(headers.entries()),
    agent,
    signal: init.signal ?? undefined
  };
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      options,
      (incoming) => {
        incoming.once("close", () => agent.destroy());
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          incoming.resume();
          reject(new RemoteProviderEgressError(
            "REMOTE_PROVIDER_REDIRECT_REJECTED"
          ));
          return;
        }
        try {
          resolve(new Response(
            noResponseBody(method, status)
              ? null
              : Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
            {
              status,
              headers: responseHeaders(incoming.headers),
              ...(incoming.statusMessage === undefined
                ? {}
                : { statusText: incoming.statusMessage })
            }
          ));
        } catch {
          incoming.destroy();
          reject(new RemoteProviderEgressError(
            "REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE"
          ));
        }
      }
    );
    request.once("error", (error) => {
      agent.destroy();
      reject(transportError(error));
    });
    if (typeof body === "string") request.write(body);
    request.end();
  });
}

export function createRemoteProviderEgressFetch(
  options: RemoteProviderEgressFetchOptions = {}
): typeof fetch {
  if (options.testOnlyTLSCA !== undefined && !options.testOnlyAllowLoopback) {
    throw new Error("Remote provider test CA requires the loopback test capability");
  }
  const transport = (async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    if (input instanceof Request ||
      (typeof input !== "string" && !(input instanceof URL))) {
      throw new RemoteProviderEgressError("REMOTE_PROVIDER_EGRESS_DENIED");
    }
    let url: URL;
    try {
      url = input instanceof URL ? new URL(input) : new URL(input);
    } catch {
      throw new RemoteProviderEgressError("REMOTE_PROVIDER_EGRESS_DENIED");
    }
    if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new RemoteProviderEgressError("REMOTE_PROVIDER_EGRESS_DENIED");
    }
    const pinned = await resolveAndPinRemoteProviderAddress(
      url,
      options.lookup,
      options.testOnlyAllowLoopback
    );
    if (url.protocol !== "https:" &&
      !(options.testOnlyAllowLoopback &&
        isLoopbackAddress(pinned.address, pinned.family))) {
      throw new RemoteProviderEgressError("REMOTE_PROVIDER_EGRESS_DENIED");
    }
    if (init.signal?.aborted) {
      throw new RemoteProviderEgressError("REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE");
    }
    return performRequest(url, init, pinned, options.testOnlyTLSCA);
  }) as typeof fetch;
  if (options.testOnlyAllowLoopback) testLoopbackFetches.add(transport);
  return transport;
}

export function remoteProviderFetchAllowsTestLoopback(
  providerFetch: typeof fetch
): boolean {
  return testLoopbackFetches.has(providerFetch);
}
