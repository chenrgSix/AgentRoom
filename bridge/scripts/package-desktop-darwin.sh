#!/usr/bin/env bash
set -euo pipefail

bridge_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${bridge_root}/.." && pwd)
output_dir=${OUTPUT_DIR:-"${bridge_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:-HEAD}
goarch=${GOARCH:?GOARCH is required}
version=${release_tag#v}
bundle_version=${version%%-*}

source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
checkout_commit=$(git -C "${repository_root}" rev-parse --verify "HEAD^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ || "${source_commit}" != "${checkout_commit}" ]]; then
  echo "Desktop packaging requires SOURCE_REF to equal the exact checked-out commit" >&2
  exit 1
fi

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

# Resolve against the caller once, before either the build or ZIP changes cwd.
mkdir -p "${output_dir}"
output_dir=$(CDPATH= cd -- "${output_dir}" && pwd -P)
minimum_macos=$(plutil -extract LSMinimumSystemVersion raw -o - "${bridge_root}/desktop/darwin/Info.plist")
if [[ ! "${minimum_macos}" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid macOS minimum version in bundle metadata" >&2
  exit 1
fi

package="convenewire-bridge-desktop_${version}_darwin_${goarch}"
staging="${output_dir}/${package}"
app="${staging}/ConveneWire Bridge.app"
contents="${app}/Contents"
binary="${contents}/MacOS/convenewire-bridge-desktop"
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
  MACOSX_DEPLOYMENT_TARGET="${minimum_macos}" \
  CGO_CFLAGS="${CGO_CFLAGS:--O2 -g} -mmacosx-version-min=${minimum_macos}" \
  CGO_CXXFLAGS="${CGO_CXXFLAGS:--O2 -g} -mmacosx-version-min=${minimum_macos}" \
  CGO_LDFLAGS="${CGO_LDFLAGS:--O2 -g} -mmacosx-version-min=${minimum_macos}" \
  CGO_ENABLED=1 GOOS=darwin GOARCH="${goarch}" go build \
    -tags desktop,production \
    -trimpath \
    -ldflags="-s -w -X main.version=${release_tag} -X main.sourceCommit=${source_commit} -extldflags=-mmacosx-version-min=${minimum_macos}" \
    -o "${binary}" \
    ./cmd/convenewire-bridge-desktop
)
# A dependency can override CGO linker flags. Verify the emitted Mach-O, not
# just the plist or environment, before any archive can be distributed.
build_target=$(xcrun vtool -show-build "${binary}")
compiled_minimum=$(awk '$1 == "minos" { print $2 }' <<< "${build_target}")
compiled_platform=$(awk '$1 == "platform" { print $2 }' <<< "${build_target}")
if [[ "${compiled_minimum}" != "${minimum_macos}" || "${compiled_platform}" != "MACOS" ]]; then
  echo "Desktop Mach-O target does not match macOS ${minimum_macos}: ${build_target}" >&2
  exit 1
fi
if ! strings "${binary}" | grep -F "${source_commit}" >/dev/null; then
  echo "Built desktop Bridge omits the exact source commit ${source_commit}" >&2
  exit 1
fi

cp "${bridge_root}/README.md" "${contents}/Resources/README.md"
cp "${repository_root}/LICENSE" "${contents}/Resources/LICENSE"
cp "${repository_root}/NOTICE" "${contents}/Resources/NOTICE"
cp "${repository_root}/COMMERCIAL-LICENSE.md" \
  "${contents}/Resources/COMMERCIAL-LICENSE.md"
cp "${repository_root}/TRADEMARKS.md" "${contents}/Resources/TRADEMARKS.md"

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
