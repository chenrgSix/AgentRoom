#!/usr/bin/env bash
set -euo pipefail

controller_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${controller_root}/../.." && pwd)
bundle_dir=${CENTRAL_IMAGE_BUNDLE_DIR:?CENTRAL_IMAGE_BUNDLE_DIR is required}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:?SOURCE_REF must identify the exact Release commit}
target_arch=${GOARCH:?GOARCH is required}
version=${release_tag#v}
sbom_generator=docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required" >&2
    return 1
  fi
}

case "${target_arch}" in
  amd64|arm64) ;;
  *)
    echo "Unsupported Central image architecture: ${target_arch}" >&2
    exit 1
    ;;
esac
source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "SOURCE_REF did not resolve to one exact lowercase commit SHA" >&2
  exit 1
fi

archive_name="convenewire-central-image_${version}_linux_${target_arch}.oci.tar"
metadata_name="convenewire-central-image_${version}_linux_${target_arch}.metadata.json"
archive="${bundle_dir}/${archive_name}"
metadata="${bundle_dir}/${metadata_name}"
if [[ ! -f "${archive}" || -L "${archive}" || ! -f "${metadata}" || -L "${metadata}" ]]; then
  echo "Central OCI archive or metadata is missing or unsafe" >&2
  exit 1
fi

expected_archive_sha=$(jq -er \
  --arg release "${release_tag}" \
  --arg source "${source_commit}" \
  --arg platform "linux/${target_arch}" \
  --arg archive "image/${archive_name}" \
  --arg generator "${sbom_generator}" '
    select(.schemaVersion == 2 and
      .releaseVersion == $release and
      .sourceCommit == $source and
      .platform == $platform and
      .archive == $archive and
      .sbomGenerator == $generator and
      (.archiveSha256 | test("^[0-9a-f]{64}$"))) |
    .archiveSha256
  ' "${metadata}")
if [[ "$(sha256_file "${archive}")" != "${expected_archive_sha}" ]]; then
  echo "Central OCI archive digest does not match its verified metadata" >&2
  exit 1
fi

runtime_records_output=$(jq -er '
  select(.schemaVersion == 2 and (.images | length) == 2) |
  .images as $images |
  [
    [
      $images[] |
      select(.role == "server" and .repository == "convenewire/server") |
      select(
        (.digest | type) == "string" and
        (.digest | test("^sha256:[0-9a-f]{64}$")) and
        .reference == (.repository + "@" + .digest) and
        (.runtimeReference | type) == "string" and
        (.runtimeReference | test("^sha256:[0-9a-f]{64}$"))
      )
    ],
    [
      $images[] |
      select(.role == "caddy" and .repository == "convenewire/caddy") |
      select(
        (.digest | type) == "string" and
        (.digest | test("^sha256:[0-9a-f]{64}$")) and
        .reference == (.repository + "@" + .digest) and
        (.runtimeReference | type) == "string" and
        (.runtimeReference | test("^sha256:[0-9a-f]{64}$"))
      )
    ]
  ] |
  select(.[0] | length == 1) |
  select(.[1] | length == 1) |
  .[] | .[0] | [.role, .runtimeReference, .reference, .digest] | @tsv
' "${metadata}")
server_runtime_reference=
caddy_runtime_reference=
server_manifest_reference=
caddy_manifest_reference=
server_manifest_digest=
caddy_manifest_digest=
while IFS=$'\t' read -r role runtime_reference manifest_reference manifest_digest; do
  case "${role}" in
    server)
      if [[ -n "${server_runtime_reference}" ]]; then
        echo "Central OCI metadata contains duplicate Server runtime references" >&2
        exit 1
      fi
      server_runtime_reference=${runtime_reference}
      server_manifest_reference=${manifest_reference}
      server_manifest_digest=${manifest_digest}
      ;;
    caddy)
      if [[ -n "${caddy_runtime_reference}" ]]; then
        echo "Central OCI metadata contains duplicate Caddy runtime references" >&2
        exit 1
      fi
      caddy_runtime_reference=${runtime_reference}
      caddy_manifest_reference=${manifest_reference}
      caddy_manifest_digest=${manifest_digest}
      ;;
    *)
      echo "Central OCI metadata contains an unsupported runtime image role" >&2
      exit 1
      ;;
  esac
done <<< "${runtime_records_output}"
if [[ -z "${server_runtime_reference}" || -z "${caddy_runtime_reference}" ||
  -z "${server_manifest_reference}" || -z "${caddy_manifest_reference}" ||
  -z "${server_manifest_digest}" || -z "${caddy_manifest_digest}" ||
  "${server_runtime_reference}" == "${caddy_runtime_reference}" ]]; then
  echo "Central OCI metadata does not contain two distinct role-bound runtime references" >&2
  exit 1
fi

references_output=$(printf '%s\n%s\n%s\n%s\n' \
  "${server_runtime_reference}" "${caddy_runtime_reference}" \
  "${server_manifest_reference}" "${caddy_manifest_reference}")
references=()
while IFS= read -r reference; do
  if [[ -n "${reference}" ]]; then
    references[${#references[@]}]=${reference}
  fi
done <<< "${references_output}"
if [[ "${#references[@]}" -ne 4 ]]; then
  echo "Central OCI metadata does not contain exactly four runtime reference candidates" >&2
  exit 1
fi
for reference in "${references[@]}"; do
  if docker image inspect "${reference}" >/dev/null 2>&1; then
    echo "Clean-daemon proof failed: ${reference} existed before bundle load" >&2
    exit 1
  fi
done

docker image load --input "${archive}"

classic_server_available=false
classic_caddy_available=false
if docker image inspect "${server_runtime_reference}" >/dev/null 2>&1; then
  classic_server_available=true
fi
if docker image inspect "${caddy_runtime_reference}" >/dev/null 2>&1; then
  classic_caddy_available=true
fi
if [[ "${classic_server_available}" != "${classic_caddy_available}" ]]; then
  echo "Loaded OCI bundle exposed only part of the classic config-digest image pair" >&2
  exit 1
fi

reference_generation=
server_expected_image_id=${server_runtime_reference}
caddy_expected_image_id=${caddy_runtime_reference}
if [[ "${classic_server_available}" == true ]]; then
  server_reference=${server_runtime_reference}
  caddy_reference=${caddy_runtime_reference}
  reference_generation=classic-config-digest
else
  containerd_server_available=false
  containerd_caddy_available=false
  if docker image inspect "${server_manifest_reference}" >/dev/null 2>&1; then
    containerd_server_available=true
  fi
  if docker image inspect "${caddy_manifest_reference}" >/dev/null 2>&1; then
    containerd_caddy_available=true
  fi
  if [[ "${containerd_server_available}" != "${containerd_caddy_available}" ]]; then
    echo "Loaded OCI bundle exposed only part of the containerd manifest-digest image pair" >&2
    exit 1
  fi
  if [[ "${containerd_server_available}" != true ]]; then
    echo "Loaded OCI bundle exposed no complete supported runtime image pair" >&2
    exit 1
  fi
  server_reference=${server_manifest_reference}
  caddy_reference=${caddy_manifest_reference}
  server_expected_image_id=${server_manifest_digest}
  caddy_expected_image_id=${caddy_manifest_digest}
  reference_generation=containerd-manifest-digest
fi

references=("${server_reference}" "${caddy_reference}")
expected_image_ids=("${server_expected_image_id}" "${caddy_expected_image_id}")
for index in "${!references[@]}"; do
  reference=${references[${index}]}
  expected_image_id=${expected_image_ids[${index}]}
  identity=$(docker image inspect --format \
    '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' \
    "${reference}")
  if [[ "${identity}" != "${expected_image_id} linux/${target_arch} ${source_commit} ${release_tag}" ]]; then
    echo "Loaded runtime image identity is invalid for ${reference}: ${identity}" >&2
    exit 1
  fi
done

server_command=$(docker image inspect --format '{{json .Config.Cmd}}' "${server_reference}")
if [[ "${server_command}" != '["node","apps/server/dist/server.js"]' ]]; then
  echo "Loaded Server image does not declare the production application command" >&2
  exit 1
fi

runtime_root=$(mktemp -d "${bundle_dir}/.convenewire-runtime-gate.XXXXXX")
runtime_data="${runtime_root}/data"
recovery_file="${runtime_root}/owner_recovery_token"
container_name="convenewire-central-runtime-${target_arch}-$$"
mkdir -m 0777 "${runtime_data}"
printf '%064d\n' 0 > "${recovery_file}"
chmod 0444 "${recovery_file}"
cleanup_runtime() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  rm -rf -- "${runtime_root}"
}
trap cleanup_runtime EXIT

# OPS-013_DEFAULT_SERVER_CMD_GATE: no command or entrypoint override is allowed.
docker run --detach --name "${container_name}" --pull=never --network none \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=${runtime_data},dst=/data" \
  --mount "type=bind,src=${recovery_file},dst=/run/secrets/owner_recovery_token,readonly" \
  --env CONVENE_WIRE_DATABASE_PATH=/data/agent-room.sqlite \
  --env "CONVENE_WIRE_RELEASE_VERSION=${release_tag}" \
  --env "CONVENE_WIRE_SOURCE_COMMIT=${source_commit}" \
  --env CONVENE_WIRE_HOST=127.0.0.1 \
  --env CONVENE_WIRE_PORT=3000 \
  --env CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE=/run/secrets/owner_recovery_token \
  --env CONVENE_WIRE_PUBLIC_ORIGIN=https://central.invalid \
  --env CONVENE_WIRE_WEB_AUTH_MODE=trusted-team \
  --env CONVENE_WIRE_WEB_ROOT=/app/apps/web/dist \
  "${server_reference}" >/dev/null

ready=false
for _ in $(seq 1 45); do
  # OPS-013_READY_GATE: the final application and migrations must reach ready.
  if docker exec "${container_name}" node -e \
    "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${container_name}" 2>/dev/null || true)" != true ]]; then
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  docker logs "${container_name}" >&2 || true
  echo "Loaded Server image did not reach application readiness with its default command" >&2
  exit 1
fi

# OPS-013_BUILD_IDENTITY_GATE: runtime metrics must match verified OCI metadata.
if ! docker exec "${container_name}" node -e '
  fetch("http://127.0.0.1:3000/api/metrics").then(async (response) => {
    const body = await response.text();
    const lines = body.split(/\r?\n/u).filter((line) =>
      line.startsWith("convenewire_build_info{")
    );
    const expected = `convenewire_build_info{release_version="${process.env.CONVENE_WIRE_RELEASE_VERSION}",source_commit="${process.env.CONVENE_WIRE_SOURCE_COMMIT}"} 1`;
    if (!response.ok || lines.length !== 1 || lines[0] !== expected) process.exit(1);
  }).catch(() => process.exit(1));
' >/dev/null; then
  docker logs "${container_name}" >&2 || true
  echo "Loaded Server runtime build identity does not match verified OCI metadata" >&2
  exit 1
fi

# OPS-013_CADDY_EXECUTION_GATE: the upstream image declares its full command
# without an Entrypoint, so the executable must remain explicit when overriding
# that command for the offline identity check.
docker run --rm --pull=never --network none --read-only \
  "${caddy_reference}" caddy version >/dev/null

printf 'Verified clean-daemon OCI load, default Server readiness/build identity, and %s execution for linux/%s\n' \
  "${reference_generation}" "${target_arch}"
