#!/usr/bin/env bash
set -euo pipefail

controller_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${controller_root}/../.." && pwd)
output_dir=${OUTPUT_DIR:-"${controller_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:?SOURCE_REF must be the exact resolved Release commit}
target_arch=${GOARCH:?GOARCH is required}
builder_id=${CENTRAL_IMAGE_BUILDER_ID:-local://convenewire/build-central-image}
invocation_uri=${CENTRAL_IMAGE_INVOCATION_URI:-}
expected_sbom_generator=docker.io/docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9
sbom_generator=${CENTRAL_SBOM_GENERATOR:-${expected_sbom_generator}}
version=${release_tag#v}

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be a v-prefixed semantic version" >&2
  exit 1
fi
if [[ "${sbom_generator}" != "${expected_sbom_generator}" ]]; then
  echo "CENTRAL_SBOM_GENERATOR must match the release verifier's pinned generator digest" >&2
  exit 1
fi
case "${target_arch}" in
  amd64|arm64) ;;
  *)
    echo "Unsupported Central image architecture: ${target_arch}" >&2
    exit 1
    ;;
esac
source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "SOURCE_REF did not resolve to one exact commit" >&2
  exit 1
fi

archive_name="convenewire-central-image_${version}_linux_${target_arch}.oci.tar"
metadata_name="convenewire-central-image_${version}_linux_${target_arch}.metadata.json"
archive="${output_dir}/${archive_name}"
metadata="${output_dir}/${metadata_name}"
mkdir -p "${output_dir}"
if [[ -e "${archive}" || -e "${metadata}" ]]; then
  echo "Central image output already exists for linux/${target_arch}" >&2
  exit 1
fi

temporary_root=$(mktemp -d "${output_dir}/.convenewire-image-build.XXXXXX")
cleanup() {
  rm -rf -- "${temporary_root}"
}
trap cleanup EXIT
context_root="${temporary_root}/context"
mkdir -p "${context_root}"
source_paths=(
  .dockerignore
  Dockerfile
  package.json
  package-lock.json
  LICENSE
  NOTICE
  COMMERCIAL-LICENSE.md
  TRADEMARKS.md
  apps/server
  apps/web
  packages/contracts
  ops/convenewirectl/image/Caddy.Dockerfile
)
git -C "${repository_root}" archive --format=tar "${source_commit}" -- "${source_paths[@]}" |
  tar -xf - -C "${context_root}"

source_date_epoch=$(git -C "${repository_root}" show -s --format=%ct "${source_commit}")
export SOURCE_DATE_EPOCH="${source_date_epoch}"
server_raw="${temporary_root}/server.raw.oci.tar"
caddy_raw="${temporary_root}/caddy.raw.oci.tar"
common_build_args=(
  --platform "linux/${target_arch}"
  --pull
  --provenance=false
  --attest "type=sbom,generator=${sbom_generator}"
  --build-arg "CONVENE_WIRE_RELEASE_VERSION=${release_tag}"
  --build-arg "CONVENE_WIRE_SOURCE_COMMIT=${source_commit}"
)

docker buildx build \
  "${common_build_args[@]}" \
  --file "${context_root}/Dockerfile" \
  --tag "convenewire/server:${release_tag}" \
  --output "type=oci,dest=${server_raw}" \
  "${context_root}"

docker buildx build \
  "${common_build_args[@]}" \
  --file "${context_root}/ops/convenewirectl/image/Caddy.Dockerfile" \
  --tag "convenewire/caddy:${release_tag}" \
  --output "type=oci,dest=${caddy_raw}" \
  "${context_root}"

go -C "${controller_root}" run ./cmd/convenewire-release-image finalize \
  --server-input "${server_raw}" \
  --caddy-input "${caddy_raw}" \
  --output "${archive}" \
  --metadata-output "${metadata}" \
  --embedded-archive "image/${archive_name}" \
  --release-version "${release_tag}" \
  --source-commit "${source_commit}" \
  --platform "linux/${target_arch}" \
  --builder-id "${builder_id}" \
  --invocation-uri "${invocation_uri}"

printf '%s\n%s\n' "${archive}" "${metadata}"
