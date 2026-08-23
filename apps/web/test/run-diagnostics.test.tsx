import assert from "node:assert/strict";
import test from "node:test";

import {
  loadRunDiagnostic,
  projectRunDiagnostic
} from "../src/run-diagnostics.js";

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
