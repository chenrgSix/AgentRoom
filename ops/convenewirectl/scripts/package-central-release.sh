#!/usr/bin/env bash
set -euo pipefail

controller_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${controller_root}/../.." && pwd)
output_dir=${OUTPUT_DIR:-"${controller_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:-"${release_tag}"}
version=${release_tag#v}

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be a v-prefixed semantic version" >&2
  exit 1
fi
source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
checkout_commit=$(git -C "${repository_root}" rev-parse --verify "HEAD^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ || "${source_commit}" != "${checkout_commit}" ]]; then
  echo "Central source packaging requires SOURCE_REF to equal the exact checked-out commit" >&2
  exit 1
fi

# shellcheck source=../release/source-layout.sh
source "${controller_root}/release/source-layout.sh"
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

package="convenewire-central_${version}_source"
mkdir -p "${output_dir}"
output_dir=$(CDPATH= cd -- "${output_dir}" && pwd -P)
archive="${output_dir}/${package}.tar.gz"
pin_asset="${output_dir}/${package}.SHA256SUMS.sha256"
if [[ -e "${archive}" || -e "${pin_asset}" ]]; then
  echo "Central source release output already exists: ${package}" >&2
  exit 1
fi

temporary_root=""
cleanup() {
  local package_status=$?
  local signal=${1:-}
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [[ -n "${temporary_root}" ]]; then
    rm -rf -- "${temporary_root}"
    if [[ -e "${temporary_root}" || -L "${temporary_root}" ]]; then
      cleanup_status=1
      echo "Failed to remove owned Central package root: ${temporary_root}" >&2
    fi
  fi
  if [[ -n "${signal}" ]]; then
    kill -s "${signal}" "$$"
    [[ "${signal}" == "INT" ]] && exit 130
    exit 143
  fi
  [[ "${package_status}" -eq 0 && "${cleanup_status}" -ne 0 ]] && package_status=1
  exit "${package_status}"
}
trap cleanup EXIT
trap 'cleanup INT' INT
trap 'cleanup TERM' TERM
temporary_root=$(mktemp -d "${output_dir}/.convenewire-central-source.XXXXXX")
staging="${temporary_root}/${package}"
mkdir -p "${staging}/bin"

git -C "${repository_root}" archive --format=tar "${source_commit}" -- "${central_source_paths[@]}" |
  tar -xf - -C "${staging}"
cp "${staging}/ops/convenewirectl/README.md" "${staging}/CENTRAL-INSTALL.md"
cp "${staging}/ops/convenewirectl/release/convenewirectl" "${staging}/bin/convenewirectl"
chmod 0755 "${staging}/bin/convenewirectl"

for target in linux/amd64 linux/arm64 darwin/arm64; do
  target_os=${target%/*}
  target_arch=${target#*/}
  target_dir="${staging}/bin/${target_os}_${target_arch}"
  mkdir -p "${target_dir}"
  (
    cd "${staging}/ops/convenewirectl"
    CGO_ENABLED=0 GOOS="${target_os}" GOARCH="${target_arch}" go build \
      -trimpath \
      -ldflags="-s -w -X main.version=${release_tag}" \
      -o "${target_dir}/convenewirectl" \
      ./cmd/convenewirectl
  )
done

printf '{"schemaVersion":3,"releaseVersion":"%s","dataSchemaVersion":%s,"sourceCommit":"%s","targetOS":"source","targetArch":"multi"}\n' \
  "${release_tag}" "${data_schema_version}" "${source_commit}" \
  > "${staging}/convenewire-central-release.json"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64|Linux/aarch64|Linux/arm64|Darwin/arm64)
    built_version=$("${staging}/bin/convenewirectl" version)
    if [[ "${built_version}" != "${release_tag}" ]]; then
      echo "Built controller reports ${built_version}, expected ${release_tag}" >&2
      exit 1
    fi
    ;;
esac

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
