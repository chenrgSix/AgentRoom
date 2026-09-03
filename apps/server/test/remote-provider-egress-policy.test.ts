import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";

import type { RemoteProviderBinding } from
  "@convene-wire/contracts/execution-plan";
import { remoteProviderBindingDigest } from
  "@convene-wire/contracts/execution-validation";

import { createServerApp } from "../src/app.js";
import { RemoteProviderClient, RemoteProviderClientError } from
  "../src/remote/remote-provider-client.js";
import {
  assertRemoteProviderAddressAllowed,
  assertRemoteProviderConnectedPeer,
  createRemoteProviderEgressFetch,
  RemoteProviderEgressError,
  resolveAndPinRemoteProviderAddress,
  type RemoteProviderResolvedAddress
} from "../src/remote/remote-provider-egress-policy.js";

const now = "2026-09-03T00:00:00.000Z";

function address(
  value: string,
  family: 4 | 6
): RemoteProviderResolvedAddress {
  return { address: value, family };
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RemoteProviderEgressError &&
    error.code === code && error.message === code;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  return bound.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
}

function binding(providerOrigin: string): RemoteProviderBinding {
  const value: RemoteProviderBinding = {
    version: 1,
    providerBindingId: "provider_sec014_boundary0001",
    teamId: "team_sec014_boundary0001",
    repositoryId: "repo_sec014_boundary0001",
    providerOrigin,
    providerRepositoryId: "owner/repository",
    ciChecks: [{
      checkKey: "unit",
      profileId: "profile_sec014_boundary0001",
      profileRevision: 1,
      profileDigest: "d".repeat(64)
    }],
    createdByMemberId: "member_sec014_boundary0001",
    bindingDigest: "0".repeat(64),
    createdAt: now
  };
  value.bindingDigest = remoteProviderBindingDigest(value);
  return value;
}

test("egress address policy admits public unicast and closes IPv4 and IPv6 bypasses", () => {
  for (const candidate of [
    address("0.0.0.0", 4),
    address("10.20.30.40", 4),
    address("100.64.0.1", 4),
    address("100.100.100.200", 4),
    address("127.42.0.1", 4),
    address("168.63.129.16", 4),
    address("169.254.169.254", 4),
    address("172.31.255.255", 4),
    address("192.168.1.1", 4),
    address("198.18.0.1", 4),
    address("224.0.0.1", 4),
    address("255.255.255.255", 4),
    address("::", 6),
    address("::1", 6),
    address("::ffff:127.0.0.1", 6),
    address("::ffff:169.254.169.254", 6),
    address("64:ff9b::a00:1", 6),
    address("2001:db8::1", 6),
    address("2002:a00:1::", 6),
    address("fc00::1", 6),
    address("fd00:ec2::254", 6),
    address("fe80::1", 6),
    address("ff02::1", 6)
  ]) {
    assert.throws(
      () => assertRemoteProviderAddressAllowed(candidate),
      errorCode("REMOTE_PROVIDER_EGRESS_DENIED"),
      candidate.address
    );
  }
  for (const candidate of [
    address("1.1.1.1", 4),
    address("8.8.8.8", 4),
    address("2001:4860:4860::8888", 6),
    address("2606:4700:4700::1111", 6),
    address("::ffff:8.8.8.8", 6)
  ]) assert.doesNotThrow(() => assertRemoteProviderAddressAllowed(candidate));

  assert.doesNotThrow(() => assertRemoteProviderAddressAllowed(
    address("127.0.0.1", 4), true
  ));
  assert.doesNotThrow(() => assertRemoteProviderAddressAllowed(
    address("::1", 6), true
  ));
  assert.throws(() => assertRemoteProviderAddressAllowed(
    address("10.0.0.1", 4), true
  ), errorCode("REMOTE_PROVIDER_EGRESS_DENIED"));
});

test("DNS answers fail closed as a complete set and peer checks require the exact pin", async () => {
  let calls = 0;
  const mixed = () => {
    calls += 1;
    return Promise.resolve([
      address("8.8.8.8", 4),
      address("10.0.0.1", 4)
    ]);
  };
  await assert.rejects(resolveAndPinRemoteProviderAddress(
    new URL("https://mixed.provider.test"), mixed
  ), errorCode("REMOTE_PROVIDER_EGRESS_DENIED"));
  assert.equal(calls, 1);

  await assert.rejects(resolveAndPinRemoteProviderAddress(
    new URL("https://cname.provider.test"),
    async () => [address("169.254.169.254", 4)]
  ), errorCode("REMOTE_PROVIDER_EGRESS_DENIED"));
  await assert.rejects(resolveAndPinRemoteProviderAddress(
    new URL("https://empty.provider.test"), async () => []
  ), errorCode("REMOTE_PROVIDER_DNS_UNAVAILABLE"));
  await assert.rejects(resolveAndPinRemoteProviderAddress(
    new URL("https://malformed.provider.test"),
    async () => [address("8.8.8.8", 6)]
  ), errorCode("REMOTE_PROVIDER_DNS_UNAVAILABLE"));
  assert.deepEqual(await resolveAndPinRemoteProviderAddress(
    new URL("https://[::1]"),
    async () => { throw new Error("literal addresses must not use DNS"); },
    true
  ), address("::1", 6));

  let rebindingAnswer = 0;
  const rebinding = async () => [rebindingAnswer++ === 0
    ? address("8.8.8.8", 4)
    : address("127.0.0.1", 4)];
  assert.deepEqual(await resolveAndPinRemoteProviderAddress(
    new URL("https://rebind.provider.test"), rebinding
  ), address("8.8.8.8", 4));
  await assert.rejects(resolveAndPinRemoteProviderAddress(
    new URL("https://rebind.provider.test"), rebinding
  ), errorCode("REMOTE_PROVIDER_EGRESS_DENIED"));

  assert.doesNotThrow(() => assertRemoteProviderConnectedPeer(
    address("8.8.8.8", 4), "::ffff:8.8.8.8"
  ));
  assert.throws(() => assertRemoteProviderConnectedPeer(
    address("8.8.8.8", 4), "8.8.4.4"
  ), errorCode("REMOTE_PROVIDER_CONNECTION_MISMATCH"));
  assert.throws(() => assertRemoteProviderConnectedPeer(
    address("8.8.8.8", 4), undefined
  ), errorCode("REMOTE_PROVIDER_CONNECTION_MISMATCH"));
});

test("direct loopback transport requires its marker, ignores proxies and rejects redirects", async (t) => {
  const requests: Array<{ authorization: string | undefined; host: string | undefined }> = [];
  const provider = createHttpServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      host: request.headers.host
    });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "http://127.0.0.1/metadata" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const port = await listen(provider);
  t.after(() => close(provider));

  const endpoint = `http://127.0.0.1:${port}`;
  await assert.rejects(createRemoteProviderEgressFetch()(`${endpoint}/ok`),
    errorCode("REMOTE_PROVIDER_EGRESS_DENIED"));
  assert.equal(requests.length, 0);

  const original = new Map<string, string | undefined>();
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    original.set(name, process.env[name]);
    process.env[name] = "http://proxy-credential@127.0.0.1:1";
  }
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const direct = createRemoteProviderEgressFetch({ testOnlyAllowLoopback: true });
  const response = await direct(`${endpoint}/ok`, {
    headers: { authorization: "Bearer sec014-runtime-token" },
    redirect: "follow"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requests, [{
    authorization: "Bearer sec014-runtime-token",
    host: `127.0.0.1:${port}`
  }]);
  await assert.rejects(direct(`${endpoint}/redirect`, {
    headers: { authorization: "Bearer sec014-runtime-token" }
  }), errorCode("REMOTE_PROVIDER_REDIRECT_REJECTED"));
  assert.equal(requests.length, 2);
});

test("HTTPS pin keeps hostname Host, SNI and certificate validation across rebinding", async (t) => {
  const [certificate, key] = await Promise.all([
    readFile(new URL("./fixtures/provider-test-cert.pem", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/provider-test-key.pem", import.meta.url), "utf8")
  ]);
  const hosts: Array<string | undefined> = [];
  const serverNames: Array<string | false> = [];
  const paths: Array<string | undefined> = [];
  const provider = createHttpsServer({ cert: certificate, key }, (request, response) => {
    hosts.push(request.headers.host);
    paths.push(request.url);
    if (request.url?.startsWith("/v1/")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  provider.on("secureConnection", (socket) => serverNames.push(socket.servername));
  const port = await listen(provider);
  t.after(() => close(provider));

  let resolution = 0;
  const pinned = createRemoteProviderEgressFetch({
    testOnlyAllowLoopback: true,
    testOnlyTLSCA: certificate,
    lookup: async () => [resolution++ === 0
      ? address("127.0.0.1", 4)
      : address("10.0.0.1", 4)]
  });
  const response = await pinned(`https://provider.test:${port}/observation`);
  assert.equal(response.status, 200);
  assert.equal(resolution, 1);
  assert.deepEqual(hosts, [`provider.test:${port}`]);
  assert.deepEqual(serverNames, ["provider.test"]);
  await assert.rejects(pinned(`https://provider.test:${port}/observation`),
    errorCode("REMOTE_PROVIDER_EGRESS_DENIED"));
  assert.equal(hosts.length, 1);

  const resolver = async () => [address("127.0.0.1", 4)];
  await assert.rejects(createRemoteProviderEgressFetch({
    testOnlyAllowLoopback: true,
    lookup: resolver
  })(`https://provider.test:${port}/untrusted`),
  errorCode("REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE"));
  await assert.rejects(createRemoteProviderEgressFetch({
    testOnlyAllowLoopback: true,
    testOnlyTLSCA: certificate,
    lookup: resolver
  })(`https://wrong-host.test:${port}/wrong-host`),
  errorCode("REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE"));
  assert.equal(hosts.length, 1);

  let protocolResolution = 0;
  const client = new RemoteProviderClient(
    () => "sec014-rebinding-runtime-token",
    createRemoteProviderEgressFetch({
      testOnlyAllowLoopback: true,
      testOnlyTLSCA: certificate,
      lookup: async () => [protocolResolution++ === 0
        ? address("127.0.0.1", 4)
        : address("10.0.0.1", 4)]
    })
  );
  await assert.rejects(client.observeCI(
    binding(`https://provider.test:${port}`),
    {
      operationId: "op_sec014_protocol_rebind0001",
      providerRepositoryId: "owner/repository",
      checkKey: "unit",
      attempt: 1,
      commit: "a".repeat(40),
      tree: "b".repeat(40)
    }
  ), (error: unknown) => error instanceof RemoteProviderClientError &&
    error.code === "REMOTE_PROVIDER_OUTCOME_UNKNOWN" && error.outcomeUnknown);
  assert.equal(protocolResolution, 2);
  assert.equal(hosts.length, 2);
  assert.deepEqual(paths, [
    "/observation",
    "/v1/ci-observations/op_sec014_protocol_rebind0001"
  ]);
});

test("concurrent requests resolve separately, open separate connections and close failures", async (t) => {
  const ports = new Set<number>();
  const provider = createHttpServer((request, response) => {
    if (request.socket.remotePort !== undefined) ports.add(request.socket.remotePort);
    setImmediate(() => response.writeHead(200).end("ok"));
  });
  const port = await listen(provider);
  let resolutions = 0;
  const direct = createRemoteProviderEgressFetch({
    testOnlyAllowLoopback: true,
    lookup: async () => {
      resolutions += 1;
      return [address("127.0.0.1", 4)];
    }
  });
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    direct(`http://parallel.provider.test:${port}/${index}`)));
  assert.deepEqual(responses.map((response) => response.status), Array(8).fill(200));
  assert.equal(resolutions, 8);
  assert.equal(ports.size, 8);
  await close(provider);

  await assert.rejects(
    direct(`http://parallel.provider.test:${port}/closed`),
    errorCode("REMOTE_PROVIDER_TRANSPORT_UNAVAILABLE")
  );
  t.after(() => {
    if (provider.listening) return close(provider);
  });
});

test("egress failures preserve only closed codes around runtime credentials", async () => {
  const providerOrigin = "https://sensitive-provider-name.example";
  const credential = "sec014-runtime-secret-never-render";
  const privateAddress = "169.254.169.254";
  const client = new RemoteProviderClient(
    () => credential,
    createRemoteProviderEgressFetch({
      lookup: async () => [address(privateAddress, 4)]
    })
  );
  await assert.rejects(client.observeCI(binding(providerOrigin), {
    operationId: "op_sec014_redaction0001",
    providerRepositoryId: "owner/repository",
    checkKey: "unit",
    attempt: 1,
    commit: "a".repeat(40),
    tree: "b".repeat(40)
  }), (error: unknown) => {
    const rendered = inspect(error, { depth: 8 });
    assert.match(rendered, /REMOTE_PROVIDER_EGRESS_DENIED/u);
    assert.doesNotMatch(rendered,
      /sec014-runtime-secret|sensitive-provider-name|169\.254\.169\.254/u);
    return true;
  });
});

test("loopback transport capability is not owned by a binding and is lost on restart", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-sec014-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, "server.sqlite");
  let app = await createServerApp({ databasePath, clock: () => now, logger: false });
  t.after(async () => app.close());
  const request = (method: "GET" | "POST", url: string, payload?: object,
    token?: string) => app.inject({
    method,
    url,
    headers: token ? { authorization: token } : {},
    ...(payload ? { payload } : {})
  });
  const bootstrap = await request("POST", "/api/bootstrap", {
    userId: "user_sec014_owner0001", displayName: "Owner"
  });
  const authorization = `Bearer ${bootstrap.json().session.token}`;
  const teamResponse = await request("POST", "/api/teams", {
    name: "SEC-014"
  }, authorization);
  const teamId = teamResponse.json().team.teamId as string;
  const command = (operationId: string) => ({
    operationId,
    repositoryId: "repo_00000001",
    providerOrigin: "http://127.0.0.1:32123",
    providerRepositoryId: "owner/repository",
    ciChecks: [{
      checkKey: "unit",
      profileId: "profile_00000001",
      profileRevision: 1,
      profileDigest: "d".repeat(64)
    }]
  });

  const denied = await request("POST",
    `/api/teams/${teamId}/remote-provider-bindings`,
    command("op_sec014_default_denied0001"), authorization);
  assert.equal(denied.statusCode, 400, denied.body);

  await app.close();
  app = await createServerApp({
    databasePath,
    clock: () => now,
    logger: false,
    remoteProviderFetch: createRemoteProviderEgressFetch({
      testOnlyAllowLoopback: true
    })
  });
  const accepted = await request("POST",
    `/api/teams/${teamId}/remote-provider-bindings`,
    command("op_sec014_marked_accept0001"), authorization);
  assert.equal(accepted.statusCode, 200, accepted.body);

  await app.close();
  app = await createServerApp({ databasePath, clock: () => now, logger: false });
  const listed = await request("GET",
    `/api/teams/${teamId}/remote-provider-bindings`, undefined, authorization);
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().bindings.length, 1);
  const deniedAfterRestart = await request("POST",
    `/api/teams/${teamId}/remote-provider-bindings`,
    command("op_sec014_restart_denied0001"), authorization);
  assert.equal(deniedAfterRestart.statusCode, 400, deniedAfterRestart.body);
  assert.doesNotMatch(deniedAfterRestart.body, /127\.0\.0\.1|32123/u);
});
