import assert from "node:assert/strict";
import test from "node:test";

import {
  assertWebAuthListener,
  loadWebAuthConfiguration
} from "../src/security/web-auth-config.js";

test("Web auth configuration defaults to loopback-only local mode", async () => {
  const configuration = await loadWebAuthConfiguration({ env: {} });
  assert.deepEqual(configuration, { mode: "local" });
  assert.doesNotThrow(() => assertWebAuthListener(configuration, "127.0.0.1"));
  assert.doesNotThrow(() => assertWebAuthListener(configuration, "::1"));
  assert.throws(
    () => assertWebAuthListener(configuration, "0.0.0.0"),
    /loopback address/u
  );
  assert.throws(
    () => assertWebAuthListener(configuration, "127.0.0.1", 1),
    /cannot trust a reverse proxy/u
  );
  assert.doesNotThrow(() =>
    assertWebAuthListener(configuration, "127.0.0.1", 0)
  );
});

test("trusted-team configuration requires an HTTPS origin and strong file secret", async () => {
  const token = "r".repeat(32);
  const configuration = await loadWebAuthConfiguration({
    cwd: "/service",
    env: {
      AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE: "secrets/owner",
      AGENT_ROOM_PUBLIC_ORIGIN: "https://team.example.com/",
      AGENT_ROOM_WEB_AUTH_MODE: "trusted-team"
    },
    loadFile: async (filename) => {
      assert.equal(filename, "/service/secrets/owner");
      return `${token}\n`;
    }
  });
  assert.deepEqual(configuration, {
    mode: "trusted-team",
    ownerRecoveryToken: token,
    publicOrigin: "https://team.example.com"
  });
  assert.doesNotThrow(() => assertWebAuthListener(configuration, "0.0.0.0"));
  assert.doesNotThrow(() => assertWebAuthListener(configuration, "0.0.0.0", 1));

  await assert.rejects(
    loadWebAuthConfiguration({
      env: {
        AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE: "/secret",
        AGENT_ROOM_PUBLIC_ORIGIN: "http://team.example.com",
        AGENT_ROOM_WEB_AUTH_MODE: "trusted-team"
      },
      loadFile: async () => token
    }),
    /HTTPS origin/u
  );
  await assert.rejects(
    loadWebAuthConfiguration({
      env: {
        AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE: "/secret",
        AGENT_ROOM_PUBLIC_ORIGIN: "https://team.example.com",
        AGENT_ROOM_WEB_AUTH_MODE: "trusted-team"
      },
      loadFile: async () => "short"
    }),
    /32 to 512 bytes/u
  );
});

test("unknown Web auth modes and missing recovery files fail closed", async () => {
  await assert.rejects(
    loadWebAuthConfiguration({
      env: { AGENT_ROOM_WEB_AUTH_MODE: "public" }
    }),
    /local or trusted-team/u
  );
  await assert.rejects(
    loadWebAuthConfiguration({
      env: {
        AGENT_ROOM_PUBLIC_ORIGIN: "https://team.example.com",
        AGENT_ROOM_WEB_AUTH_MODE: "trusted-team"
      }
    }),
    /OWNER_RECOVERY_TOKEN_FILE/u
  );
});
