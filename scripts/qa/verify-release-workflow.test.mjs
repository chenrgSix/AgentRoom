import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertTagSource,
  repositoryGateCommands,
  verifyCIWorkflowSource,
  verifyCentralImageDockerGateSource,
  verifyComposeBackupDurabilitySource,
  verifyReleaseWorkflowSource
} from "./verify-release-workflow.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(
  scriptDirectory,
  "../../.github/workflows/release-bridge.yml"
);
const workflow = await readFile(workflowPath, "utf8");
const ciWorkflow = await readFile(path.resolve(
  scriptDirectory,
  "../../.github/workflows/ci.yml"
), "utf8");
const centralDockerGate = await readFile(path.resolve(
  scriptDirectory,
  "../../ops/convenewirectl/scripts/verify-central-image-docker.sh"
), "utf8");
const composeBackup = await readFile(path.resolve(
  scriptDirectory,
  "../compose-backup.sh"
), "utf8");

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
  assert.doesNotThrow(() => verifyCentralImageDockerGateSource(centralDockerGate));
  assert.doesNotThrow(() => verifyComposeBackupDurabilitySource(composeBackup));
});

test("native Windows process-tree regressions cannot reuse the Go test cache", () => {
  assert.doesNotThrow(() => verifyCIWorkflowSource(ciWorkflow));
  assert.throws(
    () => verifyCIWorkflowSource(ciWorkflow.replace(
      "go test -count=1 ./... -run Windows -v",
      "go test ./... -run Windows"
    )),
    /must execute uncached/u
  );
});

test("backup durability cannot add a host Node runtime dependency", () => {
  const withHostNode = composeBackup.replace(
    /^sync$/mu,
    "node -e 'require(\"node:fs\").fsyncSync(1)'"
  );
  assert.throws(
    () => verifyComposeBackupDurabilitySource(withHostNode),
    /portable host sync utility|must not require host Node/u
  );

  const withoutSync = composeBackup.replace(/^sync$/mu, "true");
  assert.throws(
    () => verifyComposeBackupDurabilitySource(withoutSync),
    /portable host sync utility/u
  );
});

test("clean-daemon gate cannot bypass the final Server application", () => {
  for (const [label, changed, expected] of [
    [
      "image Cmd",
      centralDockerGate.replace(
        `'["node","apps/server/dist/server.js"]'`,
        `'["node","--version"]'`
      ),
      /production application Cmd/u
    ],
    [
      "default Cmd execution",
      centralDockerGate.replace(
        '  "${server_reference}" >/dev/null',
        '  "${server_reference}" node --version >/dev/null'
      ),
      /no command override/u
    ],
    [
      "application readiness",
      centralDockerGate.replaceAll("/api/health/ready", "/api/health/live"),
      /readiness gate must include \/api\/health\/ready/u
    ],
    [
      "runtime build identity",
      centralDockerGate.replaceAll("convenewire_build_info", "unbound_build_info"),
      /build identity gate must include convenewire_build_info/u
    ],
    [
      "Caddy executable",
      centralDockerGate.replace(
        '"${caddy_reference}" caddy version',
        '"${caddy_reference}" version'
      ),
      /Caddy execution gate must include|explicit upstream executable/u
    ],
    [
      "Bash 3.2 reference reader",
      centralDockerGate.replace(
        "while IFS= read -r reference; do",
        "mapfile -t references"
      ),
      /Bash 3\.2 reference reader/u
    ],
    [
      "portable SHA-256 helper",
      centralDockerGate.replace(
        '$(sha256_file "${archive}")',
        '$(sha256sum "${archive}" | awk \'{print $1}\')'
      ),
      /portable SHA-256 helper/u
    ]
  ]) {
    assert.throws(
      () => verifyCentralImageDockerGateSource(changed),
      expected,
      label
    );
  }
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
    "central-image",
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
  ) + "    # SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}\n");
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /central package step must include SOURCE_REF/u
  );
});

test("Central image build cannot resolve its source from the mutable tag", () => {
  const changed = mutateJob(workflow, "central-image", (block) => block.replace(
    "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
    "SOURCE_REF: ${{ inputs.release_tag }}"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /central-image build step must include SOURCE_REF/u
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

test("once-built Central OCI job cannot bypass full gates", () => {
  const changed = mutateJob(workflow, "central-image", (block) => block.replace(
    "needs: [validate-release, repository-gates, go-gates]",
    "needs: validate-release"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /central-image must depend on repository-gates/u
  );
});

test("Central OCI artifacts cannot skip the clean-daemon Docker gate", () => {
  const changed = mutateJob(workflow, "central-image", (block) => block.replace(
    "./ops/convenewirectl/scripts/verify-central-image-docker.sh",
    "echo docker-load-gate-skipped"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /central-image must include .*verify-central-image-docker/u
  );
});

test("Central SBOM generation cannot fall back to a mutable scanner tag", () => {
  const changed = mutateJob(workflow, "central-image", (block) => block.replace(
    /CENTRAL_SBOM_GENERATOR: docker\.io\/docker\/buildkit-syft-scanner@sha256:[0-9a-f]{64}/u,
    "CENTRAL_SBOM_GENERATOR: docker.io/docker/buildkit-syft-scanner:stable-1"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /central-image must include CENTRAL_SBOM_GENERATOR/u
  );
});

test("Central archives cannot skip the once-built image artifact", () => {
  const withoutDependency = mutateJob(workflow, "central", (block) => block.replace(
    "needs: [validate-release, repository-gates, go-gates, central-image]",
    "needs: [validate-release, repository-gates, go-gates]"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(withoutDependency),
    /central must depend on central-image/u
  );

  const withoutBundle = mutateJob(workflow, "central", (block) => block.replace(
    "CENTRAL_IMAGE_BUNDLE_DIR: ${{ github.workspace }}/central-image",
    "CENTRAL_RELEASE_SCHEMA: 1"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(withoutBundle),
    /central package step must include CENTRAL_IMAGE_BUNDLE_DIR/u
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

test("asset verification SOURCE_REF cannot be supplied by an unrelated step", () => {
  for (const [jobName, stepName, expected] of [
    [
      "publish",
      "Verify release assets before upload",
      /publish asset verification step must include SOURCE_REF/u
    ],
    [
      "verify-release",
      "Verify uploaded Release assets",
      /verify-release asset verification step must include SOURCE_REF/u
    ]
  ]) {
    const changed = mutateJob(workflow, jobName, (block) => {
      const marker = `      - name: ${stepName}`;
      return block
        .replace(
          "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
          "SOURCE_REF: ${{ inputs.release_tag }}"
        )
        .replace(
          marker,
          `      # SOURCE_REF: \${{ needs.validate-release.outputs.source_sha }}\n${marker}`
        );
    });
    assert.throws(
      () => verifyReleaseWorkflowSource(changed),
      expected,
      jobName
    );
  }
});
