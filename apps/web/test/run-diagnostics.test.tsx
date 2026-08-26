import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRunDiagnostic,
  projectRunDiagnostic
} from "../src/run-diagnostics.js";
import { diagnosticGuidance } from "../src/features/run/RunActivity.js";

test("failed Run diagnostics retain only safe allowlisted fields", async () => {
  const events = [{
    event: {
      type: "status",
      error: {
        code: "RUNTIME_EXIT_FAILED",
        message: "Runtime process exited unsuccessfully.",
        retryable: false,
        details: {
          category: "configuration",
          exitCode: 7,
          stderrCaptured: true,
          rawStderr: "token=must-never-reach-the-browser",
          localPath: "/Users/alice/private"
        }
      }
    }
  }];

  const diagnostic = projectRunDiagnostic(events);
  assert.deepEqual(diagnostic, {
    code: "RUNTIME_EXIT_FAILED",
    category: "configuration",
    exitCode: 7,
    retryable: false,
    stderrCaptured: true
  });
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /must-never-reach-the-browser|rawStderr|localPath|Runtime process/u
  );

  let requestedPath = "";
  const loaded = await loadRunDiagnostic("run/id", async (path) => {
    requestedPath = path;
    return events;
  });
  assert.equal(requestedPath, "/api/runs/run%2Fid/events");
  assert.deepEqual(loaded, diagnostic);
});

test("Codex session ownership failures retain only safe retry guidance", () => {
  const diagnostic = projectRunDiagnostic([{
    event: {
      type: "status",
      error: {
        code: "CODEX_SESSION_IN_USE",
        message: "provider detail with /Users/alice/private and token=secret",
        retryable: true
      }
    }
  }]);

  assert.deepEqual(diagnostic, {
    code: "CODEX_SESSION_IN_USE",
    category: null,
    exitCode: null,
    retryable: true,
    stderrCaptured: false
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /alice|secret|provider detail/u);
  assert.match(diagnosticGuidance(null, "zh-CN", diagnostic?.code), /退出 Desktop.*重试.*原会话已保留/u);
  assert.match(diagnosticGuidance(null, "en", diagnostic?.code), /quit Desktop.*retry.*preserved/ui);
  assert.match(
    diagnosticGuidance(null, "zh-CN", "CODEX_SESSION_RESUME_FAILED"),
    /保留原会话.*未新建替代会话.*重试/u
  );
});
