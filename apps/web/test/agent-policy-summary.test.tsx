import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentPolicySummary,
  filesystemAccessLabel
} from "../src/features/agent/AgentWorkspace.js";
import type { Agent } from "../src/models.js";

test("Agent policies localize bounded summaries without rendering local detail", () => {
  const maliciousPolicy = {
    filesystemAccess: "read-only",
    workspacePath: "/Users/alice/private",
    command: "codex --dangerous"
  } as Agent["runtimePolicy"];
  const html = renderToStaticMarkup(
    <>
      <AgentPolicySummary locale="zh-CN" policy={maliciousPolicy} />
      <AgentPolicySummary
        locale="zh-CN"
        policy={{ filesystemAccess: "workspace-write" }}
      />
      <AgentPolicySummary
        locale="zh-CN"
        policy={{ filesystemAccess: "local-policy" }}
      />
      <AgentPolicySummary locale="zh-CN" policy={null} />
    </>
  );

  assert.match(html, />文件访问</u);
  assert.match(html, />只读</u);
  assert.match(html, />工作区可写</u);
  assert.match(html, />遵循本机策略</u);
  assert.match(html, />未上报</u);
  assert.doesNotMatch(html, /alice|workspacePath|codex --dangerous/u);
});

test("file-access labels have complete English fallbacks", () => {
  assert.equal(filesystemAccessLabel({ filesystemAccess: "read-only" }, "en"), "Read only");
  assert.equal(filesystemAccessLabel({ filesystemAccess: "workspace-write" }, "en"), "Workspace write");
  assert.equal(filesystemAccessLabel({ filesystemAccess: "local-policy" }, "en"), "Local policy");
  assert.equal(filesystemAccessLabel(null, "en"), "Not reported");
});
