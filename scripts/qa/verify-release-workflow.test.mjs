import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTagSource,
  repositoryGateCommands,
  verifyReleaseWorkflowSource
} from "./verify-release-workflow.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(
  scriptDirectory,
  "../../.github/workflows/release-bridge.yml"
);
const workflow = await readFile(workflowPath, "utf8");

function mutateJob(source, jobName, mutate) {
  const marker = `  ${jobName}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing fixture job ${jobName}`);
  const remaining = source.slice(start + marker.length);
  const nextJobMatch = /\n  [a-z0-9-]+:\n/u.exec(remaining);
  const end = nextJobMatch
    ? start + marker.length + nextJobMatch.index
    : source.length;
  const block = source.slice(start, end);
  return `${source.slice(0, start)}${mutate(block)}${source.slice(end)}`;
}

test("Release workflow binds every checkout and build gate to one source SHA", () => {
  assert.doesNotThrow(() => verifyReleaseWorkflowSource(workflow));
});

test("tag-source assertion fails closed when a mutable tag changes", () => {
  const original = "a".repeat(40);
  assert.doesNotThrow(() => assertTagSource(original, original));
  assert.throws(
    () => assertTagSource(original, "b".repeat(40)),
    /Release tag changed/u
  );
  assert.throws(
    () => assertTagSource("refs\/tags\/v0.4.1", original),
    /full commit SHA/u
  );
});

test("every job fails policy verification if checkout falls back to the tag ref", () => {
  const checkoutJobs = [
    "repository-gates",
    "go-gates",
    "build",
    "central",
    "desktop-macos",
    "desktop-windows",
    "publish",
    "verify-release"
  ];
  for (const jobName of checkoutJobs) {
    const changed = mutateJob(workflow, jobName, (block) => block.replace(
      "ref: ${{ needs.validate-release.outputs.source_sha }}",
      "ref: refs/tags/${{ inputs.release_tag }}"
    ));
    assert.throws(
      () => verifyReleaseWorkflowSource(changed),
      /no checkout may resolve the mutable tag again/u,
      jobName
    );
  }
});

test("Central packaging cannot resolve its source from the mutable tag", () => {
  const changed = mutateJob(workflow, "central", (block) => block.replace(
    "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
    "SOURCE_REF: ${{ inputs.release_tag }}"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /central must include SOURCE_REF/u
  );
});

test("every Bridge package must receive the resolved source SHA", () => {
  for (const jobName of ["build", "desktop-macos", "desktop-windows"]) {
    const changed = mutateJob(workflow, jobName, (block) => block.replace(
      "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
      "SOURCE_REF: ${{ inputs.release_tag }}"
    ));
    assert.throws(
      () => verifyReleaseWorkflowSource(changed),
      new RegExp(`${jobName} package step must include SOURCE_REF`, "u"),
      jobName
    );
  }
});

test("workflow fails policy verification when any repository gate is skipped", () => {
  for (const command of repositoryGateCommands) {
    const changed = mutateJob(workflow, "repository-gates", (block) => block.replace(
      command,
      `echo skipped-${command.split(" ")[0]}`
    ));
    assert.throws(
      () => verifyReleaseWorkflowSource(changed),
      /repository-gates must include/u,
      command
    );
  }
});

test("workflow fails policy verification when a Go module gate is skipped", () => {
  const changed = mutateJob(workflow, "go-gates", (block) => {
    const contractsStart = block.indexOf("working-directory: packages/contracts");
    const bridgeStart = block.indexOf("working-directory: bridge", contractsStart);
    return `${block.slice(0, contractsStart)}${block
      .slice(contractsStart, bridgeStart)
      .replace("go vet ./...", "echo skipped-contract-vet")}${block.slice(bridgeStart)}`;
  });
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /go-gates packages\/contracts must include go vet/u
  );
});

test("workflow fails policy verification if an asset build bypasses full gates", () => {
  const changed = mutateJob(workflow, "desktop-windows", (block) => block.replace(
    "needs: [validate-release, repository-gates, go-gates]",
    "needs: validate-release"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /desktop-windows must depend on repository-gates/u
  );
});

test("Windows release verification cannot skip the stable upgrade source", () => {
  const changed = mutateJob(workflow, "desktop-windows", (block) => block.replace(
    "-PreviousInstallerPath $env:PREVIOUS_INSTALLER_PATH `",
    "# previous installer skipped"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /desktop-windows must include -PreviousInstallerPath/u
  );
});

test("Windows release verification cannot skip candidate ZIP or staging identity", () => {
  for (const argument of ["CandidateArchivePath", "CandidateExecutablePath"]) {
    const changed = mutateJob(workflow, "desktop-windows", (block) =>
      block.replace(new RegExp(`\\s+-${argument}[^\\n]+`, "u"), "")
    );
    assert.throws(
      () => verifyReleaseWorkflowSource(changed),
      new RegExp(`desktop-windows must include -${argument}`, "u"),
      argument
    );
  }
});

test("workflow fails policy verification without both pre-use tag rechecks", () => {
  const withoutUploadRecheck = mutateJob(workflow, "publish", (block) => block.replace(
    "node ./scripts/qa/verify-release-workflow.mjs assert-tag-source",
    "echo tag-check-skipped"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(withoutUploadRecheck),
    /publish must include node/u
  );

  const withoutDownloadRecheck = mutateJob(
    workflow,
    "verify-release",
    (block) => block.replace(
      "node ./scripts/qa/verify-release-workflow.mjs assert-tag-source",
      "echo tag-check-skipped"
    )
  );
  assert.throws(
    () => verifyReleaseWorkflowSource(withoutDownloadRecheck),
    /verify-release must include node/u
  );
});
