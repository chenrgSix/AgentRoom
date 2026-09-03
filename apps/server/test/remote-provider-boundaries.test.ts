import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RemoteProviderBinding } from
  "@convene-wire/contracts/execution-plan";
import {
  providerObservationDigest,
  remoteProviderBindingDigest
} from "@convene-wire/contracts/execution-validation";
import { validateRemoteGitBundle } from
  "../src/remote/remote-git-bundle-importer.js";
import {
  RemoteProviderClient,
  RemoteProviderClientError
} from "../src/remote/remote-provider-client.js";
import { createRemoteProviderEgressFetch } from
  "../src/remote/remote-provider-egress-policy.js";

const now = "2026-09-03T00:00:00.000Z";

function binding(): RemoteProviderBinding {
  const value: RemoteProviderBinding = {
    version: 1,
    providerBindingId: "provider_boundary0001",
    teamId: "team_boundary0001",
    repositoryId: "repo_boundary0001",
    providerOrigin: "https://provider.example",
    providerRepositoryId: "owner/repository",
    ciChecks: [{
      checkKey: "unit",
      profileId: "profile_boundary0001",
      profileRevision: 1,
      profileDigest: "d".repeat(64)
    }],
    createdByMemberId: "member_boundary0001",
    bindingDigest: "0".repeat(64),
    createdAt: now
  };
  value.bindingDigest = remoteProviderBindingDigest(value);
  return value;
}

function observation() {
  const value = {
    version: 1,
    operationId: "op_boundary_commit0001",
    observationId: "observation_boundary0001",
    providerRepositoryId: "owner/repository",
    objectFormat: "sha1" as const,
    baseCommit: "a".repeat(40),
    commit: "b".repeat(40),
    tree: "c".repeat(40),
    bundleDigest: "e".repeat(64),
    bundleByteLength: 3,
    pullRequest: null,
    providerObservationDigest: "0".repeat(64),
    observedAt: now
  };
  value.providerObservationDigest = providerObservationDigest(value);
  return value;
}

test("provider retry looks up a response-lost effect and never repeats POST", async () => {
  const retained = observation();
  let lookupCount = 0;
  let postCount = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(`/v1/commit-observations/${retained.operationId}`)) {
      lookupCount += 1;
      return lookupCount === 1
        ? new Response(null, { status: 404 })
        : Response.json(retained);
    }
    if (url.endsWith("/v1/commit-observations") && init?.method === "POST") {
      postCount += 1;
      throw new Error("response lost after provider retained the effect");
    }
    if (url.endsWith(`/v1/commit-observations/${retained.observationId}/bundle`)) {
      return new Response(Buffer.from("git"), {
        headers: {
          "content-type": "application/x-git-bundle",
          "content-length": "3"
        }
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  const client = new RemoteProviderClient(() => "runtime-only-token", providerFetch);
  const request = {
    operationId: retained.operationId,
    providerRepositoryId: retained.providerRepositoryId,
    baseCommit: retained.baseCommit,
    commit: retained.commit
  };
  await assert.rejects(client.observeCommit(binding(), request),
    (error: unknown) => error instanceof RemoteProviderClientError &&
      error.outcomeUnknown);
  assert.deepEqual(await client.observeCommit(binding(), request), {
    observation: retained,
    bundle: Buffer.from("git")
  });
  assert.equal(lookupCount, 2);
  assert.equal(postCount, 1);
});

test("provider boundary rejects missing credentials, redirects and oversized bytes", async () => {
  let calls = 0;
  const absent = new RemoteProviderClient(() => undefined, async () => {
    calls += 1;
    return new Response();
  });
  await assert.rejects(absent.observeCommit(binding(), {
    operationId: "op_boundary_commit0001",
    providerRepositoryId: "owner/repository",
    baseCommit: "a".repeat(40),
    commit: "b".repeat(40)
  }), /REMOTE_PROVIDER_CREDENTIAL_UNAVAILABLE/u);
  assert.equal(calls, 0);

  const redirected = new RemoteProviderClient(() => "token", async () =>
    new Response(null, { status: 302, headers: { location: "https://other.example" } }));
  await assert.rejects(redirected.observeCommit(binding(), {
    operationId: "op_boundary_commit0001",
    providerRepositoryId: "owner/repository",
    baseCommit: "a".repeat(40),
    commit: "b".repeat(40)
  }), /REMOTE_PROVIDER_REDIRECT_REJECTED/u);

  const retained = observation();
  const oversized = new RemoteProviderClient(() => "token", async (input) =>
    String(input).endsWith("/bundle")
      ? new Response(Buffer.from("x"), { headers: {
        "content-type": "application/x-git-bundle",
        "content-length": String((4 << 20) + 1)
      } })
      : Response.json(retained));
  await assert.rejects(oversized.observeCommit(binding(), {
    operationId: retained.operationId,
    providerRepositoryId: retained.providerRepositoryId,
    baseCommit: retained.baseCommit,
    commit: retained.commit
  }), /REMOTE_PROVIDER_RESPONSE_TOO_LARGE/u);
});

test("provider timeout aborts the bounded request without creating an effect", async () => {
  let calls = 0;
  const timedOut = new RemoteProviderClient(
    () => "runtime-only-token",
    async (_input, init) => {
      calls += 1;
      assert.equal(init?.method, "GET");
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(
          new DOMException("operation timed out", "AbortError")
        ), { once: true });
      });
    },
    5
  );
  await assert.rejects(timedOut.observeCommit(binding(), {
    operationId: "op_boundary_timeout0001",
    providerRepositoryId: "owner/repository",
    baseCommit: "a".repeat(40),
    commit: "b".repeat(40)
  }), /REMOTE_PROVIDER_TIMEOUT/u);
  assert.equal(calls, 1);
});

test("real loopback response loss reconciles by lookup and loopback timeout aborts", async (t) => {
  const retained = observation();
  let postCount = 0;
  let timeoutRequests = 0;
  let effect: ReturnType<typeof observation> | undefined;
  const provider = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer runtime-only-token") {
      response.writeHead(401).end();
      return;
    }
    if (request.url?.endsWith("op_boundary_timeout0001")) {
      timeoutRequests += 1;
      return;
    }
    if (request.method === "GET" && request.url?.endsWith(retained.operationId)) {
      if (!effect) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(effect));
      return;
    }
    if (request.method === "POST" &&
      request.url === "/v1/commit-observations") {
      postCount += 1;
      effect = retained;
      request.socket.destroy();
      return;
    }
    if (request.method === "GET" &&
      request.url?.endsWith(`/${retained.observationId}/bundle`)) {
      response.writeHead(200, {
        "content-type": "application/x-git-bundle",
        "content-length": 3
      }).end("git");
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    provider.closeAllConnections();
    provider.close((error) => error ? reject(error) : resolve());
  }));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const localBinding = binding();
  localBinding.providerOrigin = `http://127.0.0.1:${address.port}`;
  const client = new RemoteProviderClient(
    () => "runtime-only-token",
    createRemoteProviderEgressFetch({ testOnlyAllowLoopback: true }),
    100
  );
  const request = {
    operationId: retained.operationId,
    providerRepositoryId: retained.providerRepositoryId,
    baseCommit: retained.baseCommit,
    commit: retained.commit
  };
  await assert.rejects(client.observeCommit(localBinding, request),
    /REMOTE_PROVIDER_OUTCOME_UNKNOWN/u);
  assert.deepEqual(await client.observeCommit(localBinding, request), {
    observation: retained,
    bundle: Buffer.from("git")
  });
  assert.equal(postCount, 1);
  await assert.rejects(client.observeCommit(localBinding, {
    ...request,
    operationId: "op_boundary_timeout0001"
  }), /REMOTE_PROVIDER_TIMEOUT/u);
  assert.equal(timeoutRequests, 1);
});

test("Git spawn failure and malformed bundle remove only their owned temporary roots", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "convenewire-remote-cleanup-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = Buffer.from("not a bundle");
  const expected = {
    objectFormat: "sha1" as const,
    baseCommit: "a".repeat(40),
    candidateCommit: "b".repeat(40),
    candidateTree: "c".repeat(40),
    bundleDigest: (await import("node:crypto")).createHash("sha256")
      .update(source).digest("hex"),
    bundleByteLength: source.length
  };
  await assert.rejects(validateRemoteGitBundle(source, expected, {
    temporaryBase: base,
    gitExecutable: path.join(base, "missing-git")
  }), /REMOTE_PROVIDER_GIT_VALIDATION_FAILED/u);
  assert.deepEqual(await readdir(base), []);
  await assert.rejects(validateRemoteGitBundle(source, expected, {
    temporaryBase: base
  }), /REMOTE_PROVIDER_GIT_VALIDATION_FAILED/u);
  assert.deepEqual(await readdir(base), []);
});
