import assert from "node:assert/strict";
import test from "node:test";

import {
  governedGrantRevocation,
  governedOwnerPresentation
} from "./static/governed-owner-view.mjs";

test("governed owner presentation exposes only path-free inventory identities", () => {
  const secretPath = "/private/owner/source";
  const secretCommand = "owner-secret-command";
  const view = governedOwnerPresentation({
    bindings: [{bindingId: "repobind_safe0001", repositoryId: "repo_safe0001", alias: "Project",
      revision: 1, selectedRoot: secretPath}],
    grants: [{grantId: "grant_safe0001", revision: 1, digest: "a".repeat(64),
      taskId: "task_safe0001", nodeKey: "Build", operations: ["prepare", "capture"],
      expiresAt: "2026-09-03T00:00:00Z", command: secretCommand}],
    runtimeProfiles: [], verificationProfiles: [], cleanupGrants: []
  });
  const rendered = JSON.stringify(view);
  assert.match(view.summary, /1 个仓库绑定 · 1 个 Task grant/u);
  assert.doesNotMatch(rendered, new RegExp(secretPath, "u"));
  assert.doesNotMatch(rendered, new RegExp(secretCommand, "u"));
  assert.equal(view.groups[1].rows[0].revocation?.body.expectedDigest, "a".repeat(64));
});

test("governed grant revocation is exact and closed for stale or revoked views", () => {
  assert.deepEqual(governedGrantRevocation({
    grantId: "grant/id", revision: 1, digest: "b".repeat(64)
  }), {
    path: "/api/governed-task-grants/grant%2Fid/revoke",
    body: {expectedRevision: 1, expectedDigest: "b".repeat(64), confirm: true}
  });
  assert.equal(governedGrantRevocation({grantId: "grant_safe0001", revision: 2,
    digest: "b".repeat(64)}), null);
  assert.equal(governedGrantRevocation({grantId: "grant_safe0001", revision: 1,
    digest: "b".repeat(64), revokedAt: "2026-09-02T00:00:00Z"}), null);
});
