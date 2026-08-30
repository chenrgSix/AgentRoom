package releaseimage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type dockerVerifierScenario struct {
	name               string
	classicServer      bool
	classicCaddy       bool
	containerdServer   bool
	containerdCaddy    bool
	wantGeneration     string
	wantErrorSubstring string
}

func TestDockerVerifierSelectsOnlyCompleteRuntimeReferenceGeneration(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is required for the Docker verifier")
	}
	if _, err := exec.LookPath("jq"); err != nil {
		t.Skip("jq is required for the Docker verifier")
	}

	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	repositoryRoot := filepath.Clean(filepath.Join(workingDirectory, "..", "..", "..", ".."))
	scriptPath := filepath.Join(repositoryRoot, "ops", "convenewirectl", "scripts", "verify-central-image-docker.sh")
	sourceCommitBytes, err := exec.Command("git", "-C", repositoryRoot, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("resolve source commit: %v", err)
	}
	sourceCommit := strings.TrimSpace(string(sourceCommitBytes))

	tests := []dockerVerifierScenario{
		{
			name:          "classic config IDs are preferred when both generations resolve",
			classicServer: true, classicCaddy: true,
			containerdServer: true, containerdCaddy: true,
			wantGeneration: "classic-config-digest",
		},
		{
			name:             "containerd manifest references are selected as one pair",
			containerdServer: true, containerdCaddy: true,
			wantGeneration: "containerd-manifest-digest",
		},
		{
			name:             "partial classic pair fails despite complete containerd pair",
			classicServer:    true,
			containerdServer: true, containerdCaddy: true,
			wantErrorSubstring: "only part of the classic config-digest image pair",
		},
		{
			name:          "mixed generations fail closed",
			classicServer: true, containerdCaddy: true,
			wantErrorSubstring: "only part of the classic config-digest image pair",
		},
		{
			name:               "partial containerd pair fails closed",
			containerdServer:   true,
			wantErrorSubstring: "only part of the containerd manifest-digest image pair",
		},
		{
			name:               "no resolvable pair fails closed",
			wantErrorSubstring: "no complete supported runtime image pair",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runDockerVerifierScenario(t, repositoryRoot, scriptPath, sourceCommit, test)
		})
	}
}

func runDockerVerifierScenario(
	t *testing.T,
	repositoryRoot string,
	scriptPath string,
	sourceCommit string,
	scenario dockerVerifierScenario,
) {
	t.Helper()
	const releaseTag = "v0.4.0-test.1"
	const targetArchitecture = "amd64"
	const archiveName = "convenewire-central-image_0.4.0-test.1_linux_amd64.oci.tar"
	const metadataName = "convenewire-central-image_0.4.0-test.1_linux_amd64.metadata.json"
	serverRuntimeReference := "sha256:" + strings.Repeat("c", 64)
	caddyRuntimeReference := "sha256:" + strings.Repeat("d", 64)
	serverManifestReference := "convenewire/server@sha256:" + strings.Repeat("a", 64)
	caddyManifestReference := "convenewire/caddy@sha256:" + strings.Repeat("b", 64)

	bundleDirectory := t.TempDir()
	archivePath := filepath.Join(bundleDirectory, archiveName)
	archiveBytes := []byte("role-bound runtime verifier fixture\n")
	if err := os.WriteFile(archivePath, archiveBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	archiveDigest := sha256.Sum256(archiveBytes)
	metadata := map[string]any{
		"schemaVersion":  2,
		"releaseVersion": releaseTag,
		"sourceCommit":   sourceCommit,
		"platform":       "linux/" + targetArchitecture,
		"archive":        "image/" + archiveName,
		"archiveSha256":  hex.EncodeToString(archiveDigest[:]),
		"sbomGenerator":  SBOMGenerator,
		// Deliberately reverse the image order. The verifier must bind by role,
		// never by array position.
		"images": []map[string]any{
			{
				"role": "caddy", "repository": CaddyRepository,
				"digest":    strings.TrimPrefix(caddyManifestReference, CaddyRepository+"@"),
				"reference": caddyManifestReference, "runtimeReference": caddyRuntimeReference,
			},
			{
				"role": "server", "repository": ServerRepository,
				"digest":    strings.TrimPrefix(serverManifestReference, ServerRepository+"@"),
				"reference": serverManifestReference, "runtimeReference": serverRuntimeReference,
			},
		},
	}
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundleDirectory, metadataName), metadataBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	fakeBin := filepath.Join(bundleDirectory, "bin")
	if err := os.Mkdir(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	dockerLog := filepath.Join(bundleDirectory, "docker.log")
	loadMarker := filepath.Join(bundleDirectory, "loaded")
	fakeDocker := `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_DOCKER_LOG}"
if [[ "${1:-} ${2:-}" == "image inspect" ]]; then
  if [[ ! -f "${FAKE_DOCKER_LOAD_MARKER}" ]]; then
    exit 1
  fi
  reference=${!#}
  case "$*" in
    *'{{json .Config.Cmd}}'*)
      [[ "${reference}" == "${FAKE_EXPECTED_SERVER_REFERENCE}" ]]
      printf '["node","apps/server/dist/server.js"]\n'
      ;;
    *'{{.Id}} {{.Os}}/'*)
      if [[ "${reference}" == "${FAKE_EXPECTED_SERVER_REFERENCE}" ]]; then
        image_id=${FAKE_EXPECTED_SERVER_IMAGE_ID}
      elif [[ "${reference}" == "${FAKE_EXPECTED_CADDY_REFERENCE}" ]]; then
        image_id=${FAKE_EXPECTED_CADDY_IMAGE_ID}
      else
        printf 'unexpected identity reference: %s\n' "${reference}" >&2
        exit 98
      fi
      printf '%s linux/amd64 %s %s\n' "${image_id}" "${FAKE_SOURCE_COMMIT}" "${FAKE_RELEASE_TAG}"
      ;;
    *)
      case "${reference}" in
        "${FAKE_SERVER_RUNTIME_REFERENCE}") [[ "${FAKE_CLASSIC_SERVER_AVAILABLE}" == true ]] ;;
        "${FAKE_CADDY_RUNTIME_REFERENCE}") [[ "${FAKE_CLASSIC_CADDY_AVAILABLE}" == true ]] ;;
        "${FAKE_SERVER_MANIFEST_REFERENCE}") [[ "${FAKE_CONTAINERD_SERVER_AVAILABLE}" == true ]] ;;
        "${FAKE_CADDY_MANIFEST_REFERENCE}") [[ "${FAKE_CONTAINERD_CADDY_AVAILABLE}" == true ]] ;;
        *) exit 97 ;;
      esac
      ;;
  esac
elif [[ "${1:-} ${2:-}" == "image load" ]]; then
  touch "${FAKE_DOCKER_LOAD_MARKER}"
elif [[ "${1:-}" == "run" ]]; then
  if [[ "$*" == *'--detach'* ]]; then
    [[ "$*" == *"${FAKE_EXPECTED_SERVER_REFERENCE}"* ]]
    [[ "$*" != *"${FAKE_EXPECTED_CADDY_REFERENCE}"* ]]
    printf 'fixture-container\n'
  else
    [[ "$*" == *"${FAKE_EXPECTED_CADDY_REFERENCE} caddy version"* ]]
    [[ "$*" != *"${FAKE_EXPECTED_SERVER_REFERENCE}"* ]]
  fi
elif [[ "${1:-}" == "exec" || "${1:-}" == "rm" || "${1:-}" == "logs" ]]; then
  exit 0
else
  printf 'unexpected fake Docker invocation: %s\n' "$*" >&2
  exit 99
fi
`
	if err := os.WriteFile(filepath.Join(fakeBin, "docker"), []byte(fakeDocker), 0o755); err != nil {
		t.Fatal(err)
	}

	expectedServerReference := serverRuntimeReference
	expectedCaddyReference := caddyRuntimeReference
	expectedServerImageID := serverRuntimeReference
	expectedCaddyImageID := caddyRuntimeReference
	if scenario.wantGeneration == "containerd-manifest-digest" {
		expectedServerReference = serverManifestReference
		expectedCaddyReference = caddyManifestReference
		expectedServerImageID = strings.TrimPrefix(serverManifestReference, ServerRepository+"@")
		expectedCaddyImageID = strings.TrimPrefix(caddyManifestReference, CaddyRepository+"@")
	}
	command := exec.Command("bash", scriptPath)
	command.Dir = repositoryRoot
	command.Env = append(os.Environ(),
		"PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"),
		"CENTRAL_IMAGE_BUNDLE_DIR="+bundleDirectory,
		"RELEASE_TAG="+releaseTag,
		"SOURCE_REF="+sourceCommit,
		"GOARCH="+targetArchitecture,
		"FAKE_DOCKER_LOG="+dockerLog,
		"FAKE_DOCKER_LOAD_MARKER="+loadMarker,
		"FAKE_SERVER_RUNTIME_REFERENCE="+serverRuntimeReference,
		"FAKE_CADDY_RUNTIME_REFERENCE="+caddyRuntimeReference,
		"FAKE_SERVER_MANIFEST_REFERENCE="+serverManifestReference,
		"FAKE_CADDY_MANIFEST_REFERENCE="+caddyManifestReference,
		"FAKE_CLASSIC_SERVER_AVAILABLE="+strconv.FormatBool(scenario.classicServer),
		"FAKE_CLASSIC_CADDY_AVAILABLE="+strconv.FormatBool(scenario.classicCaddy),
		"FAKE_CONTAINERD_SERVER_AVAILABLE="+strconv.FormatBool(scenario.containerdServer),
		"FAKE_CONTAINERD_CADDY_AVAILABLE="+strconv.FormatBool(scenario.containerdCaddy),
		"FAKE_EXPECTED_SERVER_REFERENCE="+expectedServerReference,
		"FAKE_EXPECTED_CADDY_REFERENCE="+expectedCaddyReference,
		"FAKE_EXPECTED_SERVER_IMAGE_ID="+expectedServerImageID,
		"FAKE_EXPECTED_CADDY_IMAGE_ID="+expectedCaddyImageID,
		"FAKE_SOURCE_COMMIT="+sourceCommit,
		"FAKE_RELEASE_TAG="+releaseTag,
	)
	output, commandErr := command.CombinedOutput()

	dockerLogBytes, err := os.ReadFile(dockerLog)
	if err != nil {
		t.Fatal(err)
	}
	log := string(dockerLogBytes)
	if !strings.Contains(log, "image load --input "+archivePath) {
		t.Fatalf("Docker verifier did not load the fixture archive:\n%s", log)
	}
	if scenario.wantErrorSubstring != "" {
		if commandErr == nil {
			t.Fatalf("Docker verifier accepted an incomplete reference generation:\n%s", output)
		}
		if !strings.Contains(string(output), scenario.wantErrorSubstring) {
			t.Fatalf("Docker verifier error = %q, want %q", output, scenario.wantErrorSubstring)
		}
		if dockerLogLine(log, "run ") != "" {
			t.Fatalf("failed reference selection reached runtime execution:\n%s", log)
		}
		return
	}
	if commandErr != nil {
		t.Fatalf("Docker verifier failed: %v\n%s", commandErr, output)
	}
	if !strings.Contains(string(output), scenario.wantGeneration+" execution") {
		t.Fatalf("Docker verifier output omitted selected generation %q:\n%s", scenario.wantGeneration, output)
	}
	detachLine := dockerLogLine(log, "run --detach")
	if !strings.Contains(detachLine, expectedServerReference) {
		t.Fatalf("Server execution did not use selected reference %q:\n%s", expectedServerReference, log)
	}
	caddyLine := dockerLogLine(log, "run --rm")
	if !strings.Contains(caddyLine, expectedCaddyReference+" caddy version") {
		t.Fatalf("Caddy execution did not use selected reference %q:\n%s", expectedCaddyReference, log)
	}

	forbiddenReferences := []string{serverManifestReference, caddyManifestReference}
	if scenario.wantGeneration == "containerd-manifest-digest" {
		forbiddenReferences = []string{serverRuntimeReference, caddyRuntimeReference}
	}
	for _, line := range strings.Split(log, "\n") {
		if !strings.HasPrefix(line, "image inspect --format") && !strings.HasPrefix(line, "run ") {
			continue
		}
		for _, forbidden := range forbiddenReferences {
			if strings.Contains(line, forbidden) {
				t.Fatalf("selected generation used cross-generation reference %q in %q", forbidden, line)
			}
		}
	}
}

func dockerLogLine(log string, prefix string) string {
	for _, line := range strings.Split(log, "\n") {
		if strings.HasPrefix(line, prefix) {
			return line
		}
	}
	return ""
}
