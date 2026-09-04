#!/usr/bin/env bash
set -euo pipefail

bridge_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${bridge_root}/.." && pwd)
output_dir=${OUTPUT_DIR:-"${bridge_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:-HEAD}
goos=${GOOS:?GOOS is required}
goarch=${GOARCH:?GOARCH is required}
version=${release_tag#v}

source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
checkout_commit=$(git -C "${repository_root}" rev-parse --verify "HEAD^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ || "${source_commit}" != "${checkout_commit}" ]]; then
  echo "Bridge packaging requires SOURCE_REF to equal the exact checked-out commit" >&2
  exit 1
fi

if [[ ! "${version}" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "Release tag must contain only letters, numbers, dots, underscores, and hyphens" >&2
  exit 1
fi

case "${goos}/${goarch}" in
  linux/amd64|linux/arm64)
    archive_format=tar.gz
    ;;
  *)
    echo "Standalone Bridge releases support only linux/amd64 and linux/arm64; macOS and Windows use Desktop" >&2
    exit 1
    ;;
esac

package="convenewire-bridge_${version}_${goos}_${goarch}"
staging="${output_dir}/${package}"
binary=convenewire-bridge

mkdir -p "${staging}"
(
  cd "${bridge_root}"
  CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${release_tag} -X main.sourceCommit=${source_commit}" \
    -o "${staging}/${binary}" \
    ./cmd/convenewire-bridge
)
if ! strings "${staging}/${binary}" | grep -F "${source_commit}" >/dev/null; then
  echo "Built Bridge omits the exact source commit ${source_commit}" >&2
  exit 1
fi
cp "${bridge_root}/README.md" "${staging}/README.md"
cp "${repository_root}/LICENSE" "${staging}/LICENSE"
cp "${repository_root}/NOTICE" "${staging}/NOTICE"
cp "${repository_root}/COMMERCIAL-LICENSE.md" "${staging}/COMMERCIAL-LICENSE.md"
cp "${repository_root}/TRADEMARKS.md" "${staging}/TRADEMARKS.md"

host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)
if [[ "${goos}/${goarch}" == "${host_os}/${host_arch}" ]]; then
  built_version=$("${staging}/${binary}" version)
  if [[ "${built_version}" != "${release_tag}" ]]; then
    echo "Built Bridge reports ${built_version}, expected ${release_tag}" >&2
    exit 1
  fi
fi

cp "${bridge_root}/release/start-convenewire-bridge.sh" \
  "${staging}/start-convenewire-bridge.sh"
chmod +x "${staging}/start-convenewire-bridge.sh"

mkdir -p "${output_dir}"
if [[ "${archive_format}" == zip ]]; then
  (cd "${output_dir}" && zip -qr "${package}.zip" "${package}")
  printf '%s\n' "${output_dir}/${package}.zip"
else
  tar -C "${output_dir}" -czf "${output_dir}/${package}.tar.gz" "${package}"
  printf '%s\n' "${output_dir}/${package}.tar.gz"
fi
