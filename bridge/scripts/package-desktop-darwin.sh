#!/usr/bin/env bash
set -euo pipefail

bridge_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${bridge_root}/.." && pwd)
output_dir=${OUTPUT_DIR:-"${bridge_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
goarch=${GOARCH:?GOARCH is required}
version=${release_tag#v}
bundle_version=${version%%-*}

if [[ ! "${version}" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "Release tag must contain only letters, numbers, dots, underscores, and hyphens" >&2
  exit 1
fi
if [[ ! "${bundle_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Desktop release tag must start with a three-part semantic version" >&2
  exit 1
fi
if [[ "${goarch}" != "arm64" && "${goarch}" != "amd64" ]]; then
  echo "Unsupported macOS desktop architecture: ${goarch}" >&2
  exit 1
fi

host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)
if [[ "${host_os}/${host_arch}" != "darwin/${goarch}" ]]; then
  echo "Desktop package requires a native darwin/${goarch} builder; found ${host_os}/${host_arch}" >&2
  exit 1
fi

package="agentroom-bridge-desktop_${version}_darwin_${goarch}"
staging="${output_dir}/${package}"
app="${staging}/AgentRoom Bridge.app"
contents="${app}/Contents"
binary="${contents}/MacOS/agentroom-bridge-desktop"
archive="${output_dir}/${package}.zip"

if [[ -e "${staging}" || -e "${archive}" ]]; then
  echo "Desktop package output already exists: ${package}" >&2
  exit 1
fi

mkdir -p "${contents}/MacOS" "${contents}/Resources"
sed "s/__VERSION__/${bundle_version}/g" \
  "${bridge_root}/desktop/darwin/Info.plist" > "${contents}/Info.plist"

(
  cd "${bridge_root}"
  CGO_ENABLED=1 GOOS=darwin GOARCH="${goarch}" go build \
    -tags desktop,production \
    -trimpath \
    -ldflags="-s -w -X main.version=${release_tag}" \
    -o "${binary}" \
    ./cmd/agentroom-bridge-desktop
)

cp "${bridge_root}/README.md" "${contents}/Resources/README.md"
cp "${repository_root}/LICENSE" "${contents}/Resources/LICENSE"
cp "${repository_root}/NOTICE" "${contents}/Resources/NOTICE"
cp "${repository_root}/COMMERCIAL-LICENSE.md" \
  "${contents}/Resources/COMMERCIAL-LICENSE.md"

plutil -lint "${contents}/Info.plist"
built_version=$("${binary}" --version)
if [[ "${built_version}" != "${release_tag}" ]]; then
  echo "Built desktop Bridge reports ${built_version}, expected ${release_tag}" >&2
  exit 1
fi

(
  cd "${output_dir}"
  COPYFILE_DISABLE=1 zip -qry "${archive}" "${package}"
)
printf '%s\n' "${archive}"
