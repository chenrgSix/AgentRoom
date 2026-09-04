import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exactCommitShaPattern = /^[0-9a-f]{40}$/u;
const resolvedCheckoutRef = "${{ needs.validate-release.outputs.source_sha }}";

export const repositoryGateCommands = Object.freeze([
  "npm ci",
  "npm run validate",
  "npm run build",
  "npm test",
  "npm run test:e2e",
  "npm run lint:docs",
  "git diff --check",
  "npm run test:compose",
  "bash -n scripts/compose-backup.sh",
  "bash -n scripts/compose-restore.sh"
]);

export const goGateCommands = Object.freeze([
  "working-directory: packages/contracts",
  "working-directory: bridge",
  "working-directory: ops/convenewirectl",
  "go test ./...",
  "go vet ./...",
  "go build ./cmd/convenewirectl",
  "bash -n scripts/build-central-image.sh",
  "bash -n scripts/verify-central-image-docker.sh",
  "bash -n scripts/package-central-release.sh",
  "bash -n scripts/verify-central-release.sh",
  "./ops/convenewirectl/scripts/package-central-release.sh",
  "./ops/convenewirectl/scripts/verify-central-release.sh",
  "bash -n bridge/scripts/package-release.sh",
  "bash -n bridge/scripts/package-desktop-darwin.sh",
  "bash -n bridge/scripts/verify-release-assets.sh"
]);

export const requiredGoModuleCommands = Object.freeze({
  "packages/contracts": ["go test ./...", "go vet ./..."],
  bridge: ["go test ./...", "go vet ./..."],
  "ops/convenewirectl": [
    "go test ./...",
    "go vet ./...",
    "go build ./cmd/convenewirectl",
    "bash -n scripts/build-central-image.sh",
    "bash -n scripts/verify-central-image-docker.sh",
    "bash -n scripts/package-central-release.sh",
    "bash -n scripts/verify-central-release.sh"
  ]
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`RELEASE_WORKFLOW_POLICY: ${message}`);
  }
}

export function assertTagSource(sourceSha, tagSourceSha) {
  invariant(
    exactCommitShaPattern.test(sourceSha ?? ""),
    "the initially resolved source must be one lowercase full commit SHA"
  );
  invariant(
    exactCommitShaPattern.test(tagSourceSha ?? ""),
    "the current tag source must be one lowercase full commit SHA"
  );
  invariant(
    sourceSha === tagSourceSha,
    "the Release tag changed after its source commit was resolved"
  );
}

export function verifyCIWorkflowSource(source) {
  invariant(
    source.includes("runs-on: windows-latest"),
    "CI must retain one native Windows job"
  );
  invariant(
    source.includes("go test -count=1 ./... -run Windows -v"),
    "native Windows process regressions must execute uncached and report test names"
  );
  invariant(
    !source.includes("go test ./... -run Windows"),
    "native Windows process regressions must not use the cacheable command"
  );
  invariant(
    source.includes("Package and verify Central source release") &&
      source.includes("./ops/convenewirectl/scripts/package-central-release.sh") &&
      source.includes("./ops/convenewirectl/scripts/verify-central-release.sh") &&
      !source.includes("Package and verify Central release matrix") &&
      !source.includes("CENTRAL_RELEASE_SCHEMA: 1"),
    "CI must package and verify the current single Central source release"
  );
  verifyWindowsNativeFailures(source);
}

export function verifyReleaseAssetVerifierSource(source) {
  const requiredAssets = [
    '"convenewire-bridge_${version}_linux_amd64.tar.gz"',
    '"convenewire-bridge_${version}_linux_arm64.tar.gz"',
    '"convenewire-bridge-desktop_${version}_darwin_arm64.zip"',
    '"convenewire-bridge-desktop_${version}_windows_amd64.zip"',
    '"convenewire-bridge-desktop_${version}_windows_amd64_setup.exe"',
    '"convenewire-central_${version}_source.tar.gz"',
    '"convenewire-central_${version}_source.SHA256SUMS.sha256"',
    "license_assets=(LICENSE NOTICE COMMERCIAL-LICENSE.md TRADEMARKS.md)",
    "verify_cli_archive \"${cli_archives[0]}\" linux amd64",
    "verify_cli_archive \"${cli_archives[1]}\" linux arm64",
    "verify_macos_desktop_archive \"${desktop_archives[0]}\" arm64",
    "verify_windows_desktop_archive \"${desktop_archives[1]}\" amd64",
    'helper="${resources}/bin/convenewire-bridge"',
    'helper="${root}/convenewire-bridge.exe"'
  ];
  assertIncludes(source, requiredAssets, "combined Release asset verifier");
  for (const retiredAsset of [
    '"convenewire-bridge_${version}_darwin_amd64.tar.gz"',
    '"convenewire-bridge_${version}_darwin_arm64.tar.gz"',
    '"convenewire-bridge_${version}_windows_amd64.zip"',
    '"convenewire-bridge-desktop_${version}_darwin_amd64.zip"',
    '"convenewire-central_${version}_linux_amd64.tar.gz"'
  ]) {
    invariant(
      !source.includes(retiredAsset),
      `combined Release asset verifier must exclude retired asset ${retiredAsset}`
    );
  }
}

export function verifyWindowsNativeFailures(source) {
  const windows = requireJob(jobBlocks(source), "desktop-windows");
  const commands = [...windows.matchAll(/^          go (?:test|vet|run) [^\n]+\n([^\n]*)/gmu)];
  invariant(commands.length >= 5, "Windows native checks must remain present");
  for (const command of commands) {
    invariant(
      /^          if \(\$LASTEXITCODE -ne 0\) \{ throw "[^"\n]+" \}$/u.test(command[1]),
      "every Windows native check must immediately throw on a nonzero exit"
    );
  }
  invariant(windows.includes("./scripts/test-windows-workflow-failures.ps1"),
    "Windows must execute native failure injection");
}

export function verifyCentralImageDockerGateSource(source) {
  const defaultMarker = "# OPS-013_DEFAULT_SERVER_CMD_GATE";
  const readyMarker = "# OPS-013_READY_GATE";
  const identityMarker = "# OPS-013_BUILD_IDENTITY_GATE";
  const caddyMarker = "# OPS-013_CADDY_EXECUTION_GATE";
  const defaultStart = source.indexOf(defaultMarker);
  const readyStart = source.indexOf(readyMarker);
  const identityStart = source.indexOf(identityMarker);
  const caddyStart = source.indexOf(caddyMarker);
  invariant(defaultStart >= 0, "Central Docker gate must mark the default Server command proof");
  invariant(readyStart > defaultStart, "Central Docker gate must run readiness after default startup");
  invariant(identityStart > readyStart, "Central Docker gate must check build identity after readiness");
  invariant(caddyStart > identityStart, "Central Docker gate must check Caddy execution after Server identity");

  const commandProof = source.slice(0, defaultStart);
  const defaultRun = source.slice(defaultStart, readyStart);
  const readiness = source.slice(readyStart, identityStart);
  const identity = source.slice(identityStart, caddyStart);
  const caddyExecution = source.slice(caddyStart);
  invariant(
    !/(?:^|\s)mapfile(?:\s|$)/u.test(commandProof) &&
      commandProof.includes("while IFS= read -r reference"),
    "Central Docker gate must preserve its Bash 3.2 reference reader"
  );
  invariant(
    commandProof.includes("sha256_file()") &&
      commandProof.includes("command -v shasum") &&
      commandProof.includes('$(sha256_file "${archive}")'),
    "Central Docker gate must use its portable SHA-256 helper"
  );
  invariant(
    commandProof.includes(
      "server_command=$(docker image inspect --format '{{json .Config.Cmd}}'"
    ) && commandProof.includes(
      "'[\"node\",\"apps/server/dist/server.js\"]'"
    ),
    "Central Docker gate must require the production application Cmd"
  );
  invariant(
    defaultRun.includes("docker run --detach") &&
      defaultRun.includes('\n  "${server_reference}" >/dev/null') &&
      !defaultRun.includes("--entrypoint") &&
      !defaultRun.includes('"${server_reference}" --') &&
      !defaultRun.includes('"${server_reference}" node'),
    "Central Docker gate must start the final Server image with no command override"
  );
  assertIncludes(defaultRun, [
    "--pull=never",
    "--network none",
    "CONVENE_WIRE_DATABASE_PATH=/data/agent-room.sqlite",
    'CONVENE_WIRE_RELEASE_VERSION=${release_tag}',
    'CONVENE_WIRE_SOURCE_COMMIT=${source_commit}',
    "CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE=/run/secrets/owner_recovery_token",
    "CONVENE_WIRE_WEB_AUTH_MODE=trusted-team"
  ], "Central Docker default Server gate");
  assertIncludes(readiness, [
    'docker exec "${container_name}" node -e',
    "/api/health/ready",
    "docker logs",
    "did not reach application readiness"
  ], "Central Docker readiness gate");
  assertIncludes(identity, [
    "/api/metrics",
    "convenewire_build_info{release_version=",
    "process.env.CONVENE_WIRE_RELEASE_VERSION",
    "process.env.CONVENE_WIRE_SOURCE_COMMIT",
    "runtime build identity does not match verified OCI metadata"
  ], "Central Docker build identity gate");
  assertIncludes(caddyExecution, [
    "--pull=never",
    "--network none",
    "--read-only",
    '"${caddy_reference}" caddy version'
  ], "Central Docker Caddy execution gate");
  invariant(
    !caddyExecution.includes('"${caddy_reference}" version'),
    "Central Docker Caddy gate must invoke the explicit upstream executable"
  );
}

export function verifyComposeBackupDurabilitySource(source) {
  const marker = "# OPS-013_STANDALONE_BACKUP_SYNC";
  const markerIndex = source.indexOf(marker);
  invariant(
    markerIndex >= 0,
    "Compose backup must mark its standalone durability boundary"
  );
  const durabilityBoundary = source.slice(markerIndex);
  invariant(
    durabilityBoundary.includes("command -v sync") &&
      /^sync$/mu.test(durabilityBoundary),
    "Compose backup must use the portable host sync utility"
  );
  invariant(
    !/(?:^|\n)[ \t]*node[ \t]+-e(?:[ \t]|$)/u.test(durabilityBoundary),
    "Compose backup must not require host Node for durability"
  );
}

function jobBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const jobsIndex = lines.findIndex((line) => line === "jobs:");
  invariant(jobsIndex >= 0, "workflow must declare jobs");

  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^  ([a-z0-9-]+):\s*$/u.exec(lines[index]);
    if (match) {
      starts.push({ name: match[1], index });
    }
  }
  invariant(starts.length > 0, "workflow must declare at least one job");

  return new Map(starts.map((entry, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    return [entry.name, lines.slice(entry.index, end).join("\n")];
  }));
}

function requireJob(jobs, name) {
  const block = jobs.get(name);
  invariant(block, `required job ${name} is missing`);
  return block;
}

function needs(block) {
  const match = /^    needs:\s*(.+)$/mu.exec(block);
  invariant(match, "every gated job must declare its dependencies explicitly");
  const value = match[1].trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [value];
}

function assertNeeds(block, jobName, required) {
  const actual = new Set(needs(block));
  for (const dependency of required) {
    invariant(
      actual.has(dependency),
      `${jobName} must depend on ${dependency}`
    );
  }
}

function checkoutRefs(block) {
  const refs = [];
  const checkoutPattern = /uses:\s*actions\/checkout@[^\n]+\n\s+with:\n\s+ref:\s*([^\n]+)/gu;
  for (const match of block.matchAll(checkoutPattern)) {
    refs.push(match[1].trim());
  }
  return refs;
}

function assertResolvedCheckout(block, jobName) {
  const refs = checkoutRefs(block);
  invariant(refs.length === 1, `${jobName} must have exactly one explicit checkout`);
  invariant(
    refs[0] === resolvedCheckoutRef,
    `${jobName} must check out validate-release's resolved source SHA`
  );
}

function assertIncludes(block, snippets, scope) {
  for (const snippet of snippets) {
    invariant(block.includes(snippet), `${scope} must include ${snippet}`);
  }
}

function stepForWorkingDirectory(block, workingDirectory) {
  const directoryLine = `        working-directory: ${workingDirectory}`;
  const directoryIndex = block.indexOf(directoryLine);
  invariant(
    directoryIndex >= 0,
    `go-gates must include a step for ${workingDirectory}`
  );
  const stepStart = block.lastIndexOf("      - name:", directoryIndex);
  const nextStep = block.indexOf("\n      - name:", directoryIndex);
  invariant(stepStart >= 0, `go-gates ${workingDirectory} must be a named step`);
  return block.slice(stepStart, nextStep >= 0 ? nextStep : block.length);
}

function stepForName(block, name) {
  const marker = `      - name: ${name}`;
  const start = block.indexOf(marker);
  invariant(start >= 0, `required step ${name} is missing`);
  const next = block.indexOf("\n      - name:", start + marker.length);
  return block.slice(start, next >= 0 ? next : block.length);
}

function assertBefore(block, earlier, later, scope) {
  const earlierIndex = block.indexOf(earlier);
  const laterIndex = block.indexOf(later);
  invariant(earlierIndex >= 0, `${scope} must include ${earlier}`);
  invariant(laterIndex >= 0, `${scope} must include ${later}`);
  invariant(earlierIndex < laterIndex, `${scope} must run ${earlier} before ${later}`);
}

export function verifyReleaseWorkflowSource(source) {
  verifyWindowsNativeFailures(source);
  const jobs = jobBlocks(source);
  const validate = requireJob(jobs, "validate-release");
  const repository = requireJob(jobs, "repository-gates");
  const go = requireJob(jobs, "go-gates");
  const buildJobNames = [
    "build",
    "central",
    "desktop-macos",
    "desktop-windows"
  ];
  const checkoutJobNames = [
    "repository-gates",
    "go-gates",
    ...buildJobNames,
    "publish",
    "verify-release"
  ];

  assertIncludes(validate, [
    "outputs:",
    "source_sha: ${{ steps.resolve-source.outputs.source_sha }}",
    "id: resolve-source",
    '"repos/${GITHUB_REPOSITORY}/commits/${RELEASE_TAG}"',
    "printf 'source_sha=%s\\n' \"${source_sha}\" >> \"${GITHUB_OUTPUT}\"",
    "gh release view",
    "--json isDraft",
    "--json assets"
  ], "validate-release");

  invariant(
    !source.includes("ref: refs/tags/") && !source.includes("ref: ${{ inputs.release_tag }}"),
    "no checkout may resolve the mutable tag again"
  );
  for (const [jobName, block] of jobs.entries()) {
    if (block.includes("uses: actions/checkout@")) {
      assertResolvedCheckout(block, jobName);
    }
  }
  for (const jobName of checkoutJobNames) {
    assertResolvedCheckout(requireJob(jobs, jobName), jobName);
  }

  assertNeeds(repository, "repository-gates", ["validate-release"]);
  assertNeeds(go, "go-gates", ["validate-release"]);
  assertIncludes(repository, repositoryGateCommands, "repository-gates");
  assertIncludes(go, goGateCommands, "go-gates");
  for (const [workingDirectory, commands] of Object.entries(requiredGoModuleCommands)) {
    assertIncludes(
      stepForWorkingDirectory(go, workingDirectory),
      commands,
      `go-gates ${workingDirectory}`
    );
  }

  for (const jobName of buildJobNames) {
    assertNeeds(requireJob(jobs, jobName), jobName, [
      "validate-release",
      "repository-gates",
      "go-gates"
    ]);
  }
  invariant(
    !jobs.has("central-image"),
    "the default Release must not build embedded Central OCI bundles"
  );
  const assetBuildMarkers = [
    "package-release.sh",
    "package-central-release.sh",
    "package-desktop-darwin.sh",
    "package-desktop-windows.ps1",
    "docker build",
    "docker buildx",
    "docker/build-push-action@"
  ];
  for (const [jobName, block] of jobs.entries()) {
    if (
      jobName !== "repository-gates" &&
      jobName !== "go-gates" &&
      assetBuildMarkers.some((marker) => block.includes(marker))
    ) {
      assertNeeds(block, jobName, ["validate-release", "repository-gates", "go-gates"]);
    }
  }
  const central = requireJob(jobs, "central");
  assertIncludes(central, [
    "name: Build Central source release",
    "name: convenewire-central-source"
  ], "central");
  assertIncludes(
    stepForName(central, "Build checksum-pinned Central source archive"),
    [
      "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
      "./ops/convenewirectl/scripts/package-central-release.sh"
    ],
    "central package step"
  );
  invariant(
    !central.includes("strategy:") &&
      !central.includes("matrix:") &&
      !central.includes("matrix.") &&
      !central.includes("CENTRAL_IMAGE_BUNDLE_DIR") &&
      !central.includes("central-runtime-image"),
    "Central source packaging must be one job with no OCI matrix input"
  );

  for (const [jobName, stepName] of [
    ["build", "Build archive"],
    ["desktop-macos", "Build unsigned desktop archive"],
    ["desktop-windows", "Build and verify unsigned desktop packages"]
  ]) {
    assertIncludes(
      stepForName(requireJob(jobs, jobName), stepName),
      ["SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}"],
      `${jobName} package step`
    );
  }

  const build = requireJob(jobs, "build");
  assertIncludes(build, [
    "- goos: linux\n            goarch: amd64",
    "- goos: linux\n            goarch: arm64"
  ], "standalone Bridge CLI matrix");
  invariant(
    !build.includes("goos: darwin") && !build.includes("goos: windows"),
    "standalone Bridge CLI archives are Linux-only"
  );

  const desktopMacos = requireJob(jobs, "desktop-macos");
  assertIncludes(desktopMacos, [
    "name: Build desktop macOS/arm64",
    "runs-on: macos-15",
    "GOARCH: arm64",
    "name: convenewire-bridge-desktop-darwin-arm64"
  ], "desktop-macos");
  invariant(
    !desktopMacos.includes("strategy:") &&
      !desktopMacos.includes("matrix.") &&
      !desktopMacos.includes("macos-15-intel") &&
      !desktopMacos.includes("GOARCH: amd64"),
    "macOS Desktop must publish Apple silicon only"
  );

  const desktopWindows = requireJob(jobs, "desktop-windows");
  assertIncludes(desktopWindows, [
    "Download latest stable Windows installer",
    "gh release view",
    "gh release download $previousReleaseTag",
    'throw "Expected exactly one previous stable Windows installer"',
    "PREVIOUS_RELEASE_TAG: ${{ steps.previous-stable.outputs.release_tag }}",
    "PREVIOUS_INSTALLER_PATH: ${{ steps.previous-stable.outputs.installer_path }}",
    "-PreviousReleaseTag $env:PREVIOUS_RELEASE_TAG",
    "-PreviousInstallerPath $env:PREVIOUS_INSTALLER_PATH",
    "-CandidateArchivePath (Join-Path $env:OUTPUT_DIR",
    "-CandidateExecutablePath (Join-Path $env:OUTPUT_DIR"
  ], "desktop-windows");
  assertBefore(
    desktopWindows,
    "Download latest stable Windows installer",
    "./scripts/package-desktop-windows.ps1",
    "desktop-windows"
  );
  assertBefore(
    desktopWindows,
    "./scripts/package-desktop-windows.ps1",
    "./scripts/verify-desktop-windows-installer.ps1",
    "desktop-windows"
  );

  const publish = requireJob(jobs, "publish");
  assertNeeds(publish, "publish", [
    "validate-release",
    "build",
    "central",
    "desktop-macos",
    "desktop-windows"
  ]);
  assertIncludes(publish, [
    "SOURCE_SHA: ${{ needs.validate-release.outputs.source_sha }}",
    '"repos/${GITHUB_REPOSITORY}/commits/${RELEASE_TAG}"',
    "node ./scripts/qa/verify-release-workflow.mjs assert-tag-source",
    "gh release view",
    "--json isDraft",
    "--json assets"
  ], "publish");
  const expectedChecksummedAssets = [
    "convenewire-bridge_${version}_linux_amd64.tar.gz",
    "convenewire-bridge_${version}_linux_arm64.tar.gz",
    "convenewire-bridge-desktop_${version}_darwin_arm64.zip",
    "convenewire-bridge-desktop_${version}_windows_amd64.zip",
    "convenewire-bridge-desktop_${version}_windows_amd64_setup.exe",
    "convenewire-central_${version}_source.tar.gz",
    "convenewire-central_${version}_source.SHA256SUMS.sha256"
  ];
  assertIncludes(publish, expectedChecksummedAssets, "publish checksum closure");
  for (const retiredAsset of [
    "convenewire-bridge_${version}_darwin_amd64.tar.gz",
    "convenewire-bridge_${version}_darwin_arm64.tar.gz",
    "convenewire-bridge_${version}_windows_amd64.zip",
    "convenewire-bridge-desktop_${version}_darwin_amd64.zip",
    "convenewire-central_${version}_linux_amd64.tar.gz"
  ]) {
    invariant(
      !publish.includes(retiredAsset),
      `publish checksum closure must exclude retired asset ${retiredAsset}`
    );
  }
  assertIncludes(
    stepForName(publish, "Verify release assets before upload"),
    [
      "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
      "./bridge/scripts/verify-release-assets.sh"
    ],
    "publish asset verification step"
  );
  assertBefore(
    publish,
    "Reconfirm immutable tag source before upload",
    "Upload assets to GitHub Release",
    "publish"
  );

  const verify = requireJob(jobs, "verify-release");
  assertNeeds(verify, "verify-release", ["validate-release", "publish"]);
  assertIncludes(verify, [
    "SOURCE_SHA: ${{ needs.validate-release.outputs.source_sha }}",
    '"repos/${GITHUB_REPOSITORY}/commits/${RELEASE_TAG}"',
    "node ./scripts/qa/verify-release-workflow.mjs assert-tag-source"
  ], "verify-release");
  assertIncludes(
    stepForName(verify, "Verify uploaded Release assets"),
    [
      "SOURCE_REF: ${{ needs.validate-release.outputs.source_sha }}",
      "./bridge/scripts/verify-release-assets.sh"
    ],
    "verify-release asset verification step"
  );
  assertBefore(
    verify,
    "Reconfirm immutable tag source before download verification",
    "Download draft Release assets",
    "verify-release"
  );
}

const scriptPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

if (isMain) {
  try {
    if (process.argv[2] === "assert-tag-source") {
      assertTagSource(process.env.SOURCE_SHA, process.env.TAG_SOURCE_SHA);
    } else {
      const repositoryRoot = path.resolve(path.dirname(scriptPath), "../..");
      const workflowPath = path.join(
        repositoryRoot,
        ".github/workflows/release-bridge.yml"
      );
      verifyReleaseWorkflowSource(await readFile(workflowPath, "utf8"));
      verifyCentralImageDockerGateSource(await readFile(path.join(
        repositoryRoot,
        "ops/convenewirectl/scripts/verify-central-image-docker.sh"
      ), "utf8"));
      verifyComposeBackupDurabilitySource(await readFile(path.join(
        repositoryRoot,
        "scripts/compose-backup.sh"
      ), "utf8"));
      verifyReleaseAssetVerifierSource(await readFile(path.join(
        repositoryRoot,
        "bridge/scripts/verify-release-assets.sh"
      ), "utf8"));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
