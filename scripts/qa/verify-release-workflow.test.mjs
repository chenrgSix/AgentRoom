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
  verifyReleaseAssetVerifierSource,
  verifyReleaseWorkflowSource,
  verifyWindowsInstallerVerifierSource
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
const releaseAssetVerifier = await readFile(path.resolve(
  scriptDirectory,
  "../../bridge/scripts/verify-release-assets.sh"
), "utf8");
const windowsInstallerVerifier = await readFile(path.resolve(
  scriptDirectory,
  "../../bridge/scripts/verify-desktop-windows-installer.ps1"
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
  assert.doesNotThrow(() => verifyReleaseAssetVerifierSource(releaseAssetVerifier));
});

test("combined asset verifier cannot restore a retired top-level package", () => {
  const changed = releaseAssetVerifier.replace(
    '"convenewire-bridge_${version}_linux_amd64.tar.gz"',
    '"convenewire-bridge_${version}_darwin_amd64.tar.gz"'
  );
  assert.throws(
    () => verifyReleaseAssetVerifierSource(changed),
    /combined Release asset verifier/u
  );
});

test("Windows upgrade verifier requires the CLI helper only after candidate upgrade", () => {
  assert.doesNotThrow(() => verifyWindowsInstallerVerifierSource(windowsInstallerVerifier));

  const legacyRequiresHelper = windowsInstallerVerifier.replace(
    "Assert-InstalledPayload -ExpectedReleaseTag $PreviousReleaseTag",
    "Assert-InstalledPayload -ExpectedReleaseTag $PreviousReleaseTag -RequireCLIHelper"
  );
  assert.throws(
    () => verifyWindowsInstallerVerifierSource(legacyRequiresHelper),
    /must not impose the new CLI helper/u
  );

  const candidateOmitsHelper = windowsInstallerVerifier.replace(
    "    -ExpectedExecutableSHA256 $candidateExecutableSHA256 `\n    -RequireCLIHelper",
    "    -ExpectedExecutableSHA256 $candidateExecutableSHA256 `\n    -ConfirmCandidate"
  );
  assert.throws(
    () => verifyWindowsInstallerVerifierSource(candidateOmitsHelper),
    /must include -RequireCLIHelper|must require the CLI helper/u
  );
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

test("each Windows native exit guard is mandatory, immediate and terminating", () => {
  for (const [source, verify] of [[ciWorkflow, verifyCIWorkflowSource], [workflow, verifyReleaseWorkflowSource]]) {
    const windows = /  desktop-windows:\n[\s\S]*?(?=\n  [a-z0-9-]+:|$)/u.exec(source)[0];
    const guards = [...windows.matchAll(/(          go (?:test|vet|run) [^\n]+\n)(          if \(\$LASTEXITCODE -ne 0\) \{ throw "[^"\n]+" \})/gu)];
    assert.ok(guards.length >= 5);
    for (const [whole, command, guard] of guards) {
      for (const replacement of [command, command + guard.replace("throw", "Write-Output"), command + "          go version\n" + guard]) {
        assert.throws(() => verify(source.replace(whole, replacement)), /must immediately throw/u);
      }
    }
  }
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

test("default Release cannot restore the embedded Central OCI matrix", () => {
  const changed = workflow.replace(
    "  central:\n",
    "  central-image:\n    needs: [validate-release, repository-gates, go-gates]\n    runs-on: ubuntu-latest\n    steps: []\n\n  central:\n"
  );
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /must not build embedded Central OCI bundles/u
  );
});

test("Central source archive cannot regain matrix or OCI inputs", () => {
  for (const addition of [
    "    strategy:\n      matrix:\n        goarch: [amd64, arm64]\n",
    "    env:\n      CENTRAL_IMAGE_BUNDLE_DIR: central-image\n"
  ]) {
    const changed = mutateJob(workflow, "central", (block) => block.replace(
      "    runs-on: ubuntu-latest\n",
      `    runs-on: ubuntu-latest\n${addition}`
    ));
    assert.throws(
      () => verifyReleaseWorkflowSource(changed),
      /one job with no OCI matrix input/u
    );
  }
});

test("standalone Bridge CLI matrix remains Linux-only", () => {
  const changed = mutateJob(workflow, "build", (block) => block.replace(
    "          - goos: linux\n            goarch: amd64",
    "          - goos: windows\n            goarch: amd64"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /standalone Bridge CLI matrix must include|Linux-only/u
  );
});

test("macOS Desktop remains Apple silicon only", () => {
  const changed = mutateJob(workflow, "desktop-macos", (block) => block.replace(
    "runs-on: macos-15",
    "runs-on: macos-15-intel"
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /desktop-macos must include runs-on: macos-15|Apple silicon only/u
  );
});

test("publish checksum closure cannot restore retired assets", () => {
  const changed = mutateJob(workflow, "publish", (block) => block.replace(
    '"convenewire-bridge_${version}_linux_amd64.tar.gz"',
    '"convenewire-bridge_${version}_darwin_amd64.tar.gz"'
  ));
  assert.throws(
    () => verifyReleaseWorkflowSource(changed),
    /publish checksum closure/u
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
