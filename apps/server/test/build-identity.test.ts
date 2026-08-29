import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuildIdentity } from
  "../src/observability/build-identity.js";

test("build identity defaults only to the explicit development pair", () => {
  assert.deepEqual(resolveBuildIdentity(), {
    releaseVersion: "development",
    sourceCommit: "unknown"
  });
  assert.deepEqual(resolveBuildIdentity("development", "unknown"), {
    releaseVersion: "development",
    sourceCommit: "unknown"
  });
});

test("build identity accepts an exact release tag and full source commit", () => {
  assert.deepEqual(
    resolveBuildIdentity(
      "v0.4.0-qa035.1",
      "0123456789abcdef0123456789abcdef01234567"
    ),
    {
      releaseVersion: "v0.4.0-qa035.1",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567"
    }
  );
});

test("build identity rejects partial or non-exact release metadata", () => {
  assert.throws(
    () => resolveBuildIdentity("v0.4.0", undefined),
    /must be set together/u
  );
  assert.throws(
    () => resolveBuildIdentity(undefined, "0123456789abcdef0123456789abcdef01234567"),
    /must be set together/u
  );
  assert.throws(
    () => resolveBuildIdentity("0.4.0", "0123456789abcdef0123456789abcdef01234567"),
    /v-prefixed semantic version/u
  );
  assert.throws(
    () => resolveBuildIdentity("v0.4.0", "0123456"),
    /40-character lowercase Git commit/u
  );
  assert.throws(
    () => resolveBuildIdentity("v0.4.0", "ABCDEF0123456789ABCDEF0123456789ABCDEF01"),
    /40-character lowercase Git commit/u
  );
  assert.throws(
    () => resolveBuildIdentity("development", "0123456789abcdef0123456789abcdef01234567"),
    /v-prefixed semantic version/u
  );
});
