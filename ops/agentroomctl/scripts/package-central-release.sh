#!/usr/bin/env bash
set -euo pipefail

controller_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${controller_root}/../.." && pwd)
output_dir=${OUTPUT_DIR:-"${controller_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:-"${release_tag}"}
target_os=${GOOS:?GOOS is required}
target_arch=${GOARCH:?GOARCH is required}
version=${release_tag#v}

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be a v-prefixed semantic version" >&2
  exit 1
fi
case "${target_os}/${target_arch}" in
  darwin/amd64|darwin/arm64|linux/amd64|linux/arm64) ;;
  *)
    echo "Unsupported Central release target: ${target_os}/${target_arch}" >&2
    exit 1
    ;;
esac

source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "Could not resolve an exact source commit from ${source_ref}" >&2
  exit 1
fi

data_schema_version=${DATA_SCHEMA_VERSION:-}
if [[ -z "${data_schema_version}" ]]; then
  latest_migration=$(git -C "${repository_root}" ls-tree -r --name-only "${source_commit}" -- apps/server/migrations |
    sed -nE 's#^apps/server/migrations/([0-9]{4})_.*\.sql$#\1#p' |
    sort -n | tail -n 1)
  data_schema_version=$((10#${latest_migration:?No source migration found}))
fi
if [[ ! "${data_schema_version}" =~ ^[1-9][0-9]*$ ]]; then
  echo "DATA_SCHEMA_VERSION must be a positive integer" >&2
  exit 1
fi

package="agentroom-central_${version}_${target_os}_${target_arch}"
archive="${output_dir}/${package}.tar.gz"
pin_asset="${output_dir}/${package}.SHA256SUMS.sha256"
mkdir -p "${output_dir}"
if [[ -e "${archive}" || -e "${pin_asset}" ]]; then
  echo "Central release output already exists for ${target_os}/${target_arch}" >&2
  exit 1
fi

temporary_root=$(mktemp -d "${output_dir}/.agentroom-central-package.XXXXXX")
cleanup() {
  rm -rf -- "${temporary_root}"
}
trap cleanup EXIT
staging="${temporary_root}/${package}"
mkdir -p "${staging}/bin"

source_paths=(
  .dockerignore
  Dockerfile
  compose.yaml
  package.json
  package-lock.json
  LICENSE
  NOTICE
  COMMERCIAL-LICENSE.md
  TRADEMARKS.md
  apps/server
  apps/web
  packages/contracts
  deploy/Caddyfile
  deploy/tls
  scripts/compose-backup.sh
  scripts/compose-restore.sh
  ops/agentroomctl
)
git -C "${repository_root}" archive --format=tar "${source_commit}" -- "${source_paths[@]}" |
  tar -xf - -C "${staging}"

cp "${staging}/ops/agentroomctl/README.md" "${staging}/CENTRAL-INSTALL.md"
(
  cd "${staging}/ops/agentroomctl"
  CGO_ENABLED=0 GOOS="${target_os}" GOARCH="${target_arch}" go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${release_tag}" \
    -o "${staging}/bin/agentroomctl" \
    ./cmd/agentroomctl
)
rm -rf -- "${staging}/ops"

printf '{"schemaVersion":1,"releaseVersion":"%s","dataSchemaVersion":%s,"sourceCommit":"%s","targetOS":"%s","targetArch":"%s"}\n' \
  "${release_tag}" "${data_schema_version}" "${source_commit}" "${target_os}" "${target_arch}" \
  > "${staging}/agentroom-central-release.json"

host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)
if [[ "${target_os}/${target_arch}" == "${host_os}/${host_arch}" ]]; then
  built_version=$("${staging}/bin/agentroomctl" version)
  if [[ "${built_version}" != "${release_tag}" ]]; then
    echo "Built controller reports ${built_version}, expected ${release_tag}" >&2
    exit 1
  fi
fi

(
  cd "${staging}"
  find . -type f ! -name SHA256SUMS -print |
    sed 's#^\./##' |
    LC_ALL=C sort |
    while IFS= read -r filename; do
      if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${filename}"
      else
        shasum -a 256 "${filename}"
      fi
    done > SHA256SUMS
)

if command -v sha256sum >/dev/null 2>&1; then
  internal_digest=$(sha256sum "${staging}/SHA256SUMS" | awk '{print $1}')
else
  internal_digest=$(shasum -a 256 "${staging}/SHA256SUMS" | awk '{print $1}')
fi
printf '%s  SHA256SUMS\n' "${internal_digest}" > "${pin_asset}"
tar -C "${temporary_root}" -czf "${archive}" "${package}"

printf '%s\n%s\n' "${archive}" "${pin_asset}"
