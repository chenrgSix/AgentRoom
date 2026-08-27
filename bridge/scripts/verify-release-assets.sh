#!/usr/bin/env bash
set -euo pipefail

bridge_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${bridge_root}/.." && pwd)
asset_dir=${ASSET_DIR:?ASSET_DIR is required}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
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
if [[ ! -d "${asset_dir}" ]]; then
  echo "Release asset directory does not exist: ${asset_dir}" >&2
  exit 1
fi

cli_archives=(
  "agentroom-bridge_${version}_darwin_amd64.tar.gz"
  "agentroom-bridge_${version}_darwin_arm64.tar.gz"
  "agentroom-bridge_${version}_linux_amd64.tar.gz"
  "agentroom-bridge_${version}_linux_arm64.tar.gz"
  "agentroom-bridge_${version}_windows_amd64.zip"
)
desktop_archives=(
  "agentroom-bridge-desktop_${version}_darwin_amd64.zip"
  "agentroom-bridge-desktop_${version}_darwin_arm64.zip"
  "agentroom-bridge-desktop_${version}_windows_amd64.zip"
)
desktop_installers=(
  "agentroom-bridge-desktop_${version}_windows_amd64_setup.exe"
)
license_assets=(LICENSE NOTICE COMMERCIAL-LICENSE.md TRADEMARKS.md)
expected_count=$((${#cli_archives[@]} + ${#desktop_archives[@]} + ${#desktop_installers[@]} + ${#license_assets[@]} + 1))
actual_count=$(find "${asset_dir}" -mindepth 1 -maxdepth 1 -print | wc -l | tr -d ' ')

if [[ "${actual_count}" -ne "${expected_count}" ]]; then
  echo "Expected ${expected_count} release assets, found ${actual_count}" >&2
  find "${asset_dir}" -mindepth 1 -maxdepth 1 -print >&2
  exit 1
fi

for filename in "${cli_archives[@]}" "${desktop_archives[@]}" "${desktop_installers[@]}" SHA256SUMS "${license_assets[@]}"; do
  if [[ ! -f "${asset_dir}/${filename}" ]]; then
    echo "Missing release asset: ${filename}" >&2
    exit 1
  fi
done

for filename in "${license_assets[@]}"; do
  if ! cmp -s "${repository_root}/${filename}" "${asset_dir}/${filename}"; then
    echo "Top-level release license does not match the tagged source: ${filename}" >&2
    exit 1
  fi
done

checksum_names=$(awk '
  !/^[0-9a-fA-F]{64}  [0-9A-Za-z._-]+$/ { invalid = 1 }
  { print $2 }
  END { if (invalid) exit 1 }
' "${asset_dir}/SHA256SUMS") || {
  echo "SHA256SUMS contains an invalid entry" >&2
  exit 1
}
expected_checksum_names=$(printf '%s\n' "${cli_archives[@]}" "${desktop_archives[@]}" "${desktop_installers[@]}" | sort)
actual_checksum_names=$(printf '%s\n' "${checksum_names}" | sort)
if [[ "${actual_checksum_names}" != "${expected_checksum_names}" ]]; then
  echo "SHA256SUMS must contain each Bridge archive exactly once" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "${asset_dir}" && sha256sum -c SHA256SUMS)
elif command -v shasum >/dev/null 2>&1; then
  (cd "${asset_dir}" && shasum -a 256 -c SHA256SUMS)
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/agentroom-release-verify.XXXXXX")
cleanup() {
  rm -rf "${temporary_root}"
}
trap cleanup EXIT

assert_safe_members() {
  local archive=$1
  local members=$2
  if grep -Eq '(^|/)(\.\.?)(/|$)|^/' "${members}"; then
    echo "Archive contains an unsafe path: ${archive}" >&2
    exit 1
  fi
}

assert_binary_version() {
  local binary=$1
  local escaped_release_tag=${release_tag//./\\.}
  if ! strings "${binary}" |
    grep -E "${escaped_release_tag}([^0-9A-Za-z._-]|$)" >/dev/null; then
    echo "Binary does not contain the injected release version ${release_tag}: ${binary}" >&2
    exit 1
  fi
}

assert_binary_architecture() {
  local binary=$1
  local target=$2
  local description
  description=$(file -b "${binary}")
  case "${target}" in
    darwin/amd64)
      [[ "${description}" =~ Mach-O.*x86_64 ]] || {
        echo "Binary architecture mismatch for ${target}: ${description}" >&2
        exit 1
      }
      ;;
    darwin/arm64)
      [[ "${description}" =~ Mach-O.*arm64 ]] || {
        echo "Binary architecture mismatch for ${target}: ${description}" >&2
        exit 1
      }
      ;;
    linux/amd64)
      [[ "${description}" =~ ELF.*x86-64 ]] || {
        echo "Binary architecture mismatch for ${target}: ${description}" >&2
        exit 1
      }
      ;;
    linux/arm64)
      [[ "${description}" =~ ELF.*ARM.aarch64 ]] || {
        echo "Binary architecture mismatch for ${target}: ${description}" >&2
        exit 1
      }
      ;;
    windows/amd64)
      [[ "${description}" =~ PE32\+.*x86-64 ]] || {
        echo "Binary architecture mismatch for ${target}: ${description}" >&2
        exit 1
      }
      ;;
  esac
}

assert_licenses() {
  local directory=$1
  local filename
  for filename in "${license_assets[@]}"; do
    if ! cmp -s "${asset_dir}/${filename}" "${directory}/${filename}"; then
      echo "Archive license does not match top-level asset: ${directory}/${filename}" >&2
      exit 1
    fi
  done
}

verify_cli_archive() {
  local archive=$1
  local platform=$2
  local architecture=$3
  local package=${archive%.tar.gz}
  package=${package%.zip}
  local extraction="${temporary_root}/${package}"
  local members="${temporary_root}/${package}.members"
  local root
  local binary
  local launcher

  mkdir -p "${extraction}"
  case "${archive}" in
    *.tar.gz)
      tar -tzf "${asset_dir}/${archive}" > "${members}"
      assert_safe_members "${archive}" "${members}"
      tar -xzf "${asset_dir}/${archive}" -C "${extraction}"
      ;;
    *.zip)
      unzip -Z1 "${asset_dir}/${archive}" > "${members}"
      assert_safe_members "${archive}" "${members}"
      unzip -q "${asset_dir}/${archive}" -d "${extraction}"
      ;;
  esac

  root="${extraction}/${package}"
  binary="${root}/agentroom-bridge"
  case "${platform}" in
    darwin)
      launcher="${root}/Start AgentRoom Bridge.command"
      ;;
    linux)
      launcher="${root}/start-agentroom-bridge.sh"
      ;;
    windows)
      binary="${binary}.exe"
      launcher="${root}/Start AgentRoom Bridge.cmd"
      ;;
  esac

  for filename in README.md LICENSE NOTICE COMMERCIAL-LICENSE.md TRADEMARKS.md; do
    if [[ ! -s "${root}/${filename}" ]]; then
      echo "Missing or empty archive file: ${archive}:${filename}" >&2
      exit 1
    fi
  done
  if [[ ! -s "${binary}" || ! -s "${launcher}" ]]; then
    echo "Archive is missing its binary or launcher: ${archive}" >&2
    exit 1
  fi
  if ! grep -Fq agentroom-bridge "${launcher}" || ! grep -Fq console "${launcher}"; then
    echo "Archive launcher does not start the Bridge Console: ${archive}" >&2
    exit 1
  fi
  if [[ "${platform}" != windows && ( ! -x "${binary}" || ! -x "${launcher}" ) ]]; then
    echo "Archive binary and launcher must be executable: ${archive}" >&2
    exit 1
  fi
  assert_binary_version "${binary}"
  assert_binary_architecture "${binary}" "${platform}/${architecture}"
  assert_licenses "${root}"
}

verify_macos_desktop_archive() {
  local archive=$1
  local architecture=$2
  local package=${archive%.zip}
  local extraction="${temporary_root}/${package}"
  local members="${temporary_root}/${package}.members"
  local contents
  local resources
  local binary

  mkdir -p "${extraction}"
  unzip -Z1 "${asset_dir}/${archive}" > "${members}"
  assert_safe_members "${archive}" "${members}"
  unzip -q "${asset_dir}/${archive}" -d "${extraction}"

  contents="${extraction}/${package}/AgentRoom Bridge.app/Contents"
  resources="${contents}/Resources"
  binary="${contents}/MacOS/agentroom-bridge-desktop"
  if [[ ! -s "${contents}/Info.plist" || ! -x "${binary}" || ! -s "${resources}/README.md" ]]; then
    echo "Desktop archive is missing its application metadata, executable, or README: ${archive}" >&2
    exit 1
  fi
  if ! grep -Fq '<string>dev.agentroom.bridge</string>' "${contents}/Info.plist"; then
    echo "Desktop archive has the wrong bundle identifier: ${archive}" >&2
    exit 1
  fi
  if [[ $(grep -Fc "<string>${bundle_version}</string>" "${contents}/Info.plist") -lt 2 ]]; then
    echo "Desktop archive has the wrong bundle version: ${archive}" >&2
    exit 1
  fi
  if ! grep -Fq '<string>agentroom</string>' "${contents}/Info.plist"; then
    echo "Desktop archive is missing the Device pairing URL scheme: ${archive}" >&2
    exit 1
  fi
  assert_binary_version "${binary}"
  assert_binary_architecture "${binary}" "darwin/${architecture}"
  assert_licenses "${resources}"
}

verify_windows_desktop_archive() {
  local archive=$1
  local architecture=$2
  local package=${archive%.zip}
  local extraction="${temporary_root}/${package}"
  local members="${temporary_root}/${package}.members"
  local root
  local binary

  mkdir -p "${extraction}"
  unzip -Z1 "${asset_dir}/${archive}" > "${members}"
  assert_safe_members "${archive}" "${members}"
  unzip -q "${asset_dir}/${archive}" -d "${extraction}"

  root="${extraction}/${package}"
  binary="${root}/AgentRoom Bridge.exe"
  if [[ ! -s "${binary}" || ! -s "${root}/README.md" ]]; then
    echo "Windows Desktop archive is missing its executable or README: ${archive}" >&2
    exit 1
  fi
  assert_binary_version "${binary}"
  assert_binary_architecture "${binary}" "windows/${architecture}"
  assert_licenses "${root}"
}

extract_utf16le_strings() {
  local binary=$1
  if strings -el "${binary}" >/dev/null 2>&1; then
    strings -el "${binary}"
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "GNU strings or python3 is required to inspect Windows installer metadata" >&2
    exit 1
  fi
  python3 - "${binary}" <<'PY'
import re
import sys

with open(sys.argv[1], "rb") as binary_file:
    data = binary_file.read()
for match in re.finditer(rb"(?:[\x20-\x7e]\x00){4,}", data):
    print(match.group().decode("utf-16le"))
PY
}

verify_windows_desktop_installer() {
  local installer=$1
  local path="${asset_dir}/${installer}"
  local description
  local installer_strings="${temporary_root}/${installer}.strings"

  if [[ ! -s "${path}" ]]; then
    echo "Windows Desktop installer is missing or empty: ${installer}" >&2
    exit 1
  fi
  description=$(file -b "${path}")
  if [[ ! "${description}" =~ PE32(\+)?\ executable.*(Intel\ 80386|x86-64) ]]; then
    echo "Windows Desktop installer is not a Windows GUI executable: ${description}" >&2
    exit 1
  fi
  {
    strings "${path}"
    extract_utf16le_strings "${path}"
  } > "${installer_strings}"
  if ! grep -Fq "AgentRoom Bridge" "${installer_strings}" ||
    ! grep -Fq "${version}" "${installer_strings}"; then
    echo "Windows Desktop installer is missing product or version metadata: ${installer}" >&2
    exit 1
  fi
}

verify_cli_archive "${cli_archives[0]}" darwin amd64
verify_cli_archive "${cli_archives[1]}" darwin arm64
verify_cli_archive "${cli_archives[2]}" linux amd64
verify_cli_archive "${cli_archives[3]}" linux arm64
verify_cli_archive "${cli_archives[4]}" windows amd64
verify_macos_desktop_archive "${desktop_archives[0]}" amd64
verify_macos_desktop_archive "${desktop_archives[1]}" arm64
verify_windows_desktop_archive "${desktop_archives[2]}" amd64
verify_windows_desktop_installer "${desktop_installers[0]}"

printf 'Verified %s release assets for %s\n' "${expected_count}" "${release_tag}"
