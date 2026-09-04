#!/usr/bin/env bash
set -euo pipefail

controller_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
repository_root=$(CDPATH= cd -- "${controller_root}/../.." && pwd)
asset_dir=${ASSET_DIR:?ASSET_DIR is required}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
source_ref=${SOURCE_REF:-"${release_tag}"}
version=${release_tag#v}

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must be a v-prefixed semantic version" >&2
  exit 1
fi
if [[ ! -d "${asset_dir}" ]]; then
  echo "Central release asset directory does not exist: ${asset_dir}" >&2
  exit 1
fi
source_commit=$(git -C "${repository_root}" rev-parse --verify "${source_ref}^{commit}")
checkout_commit=$(git -C "${repository_root}" rev-parse --verify "HEAD^{commit}")
if [[ ! "${source_commit}" =~ ^[0-9a-f]{40}$ || "${source_commit}" != "${checkout_commit}" ]]; then
  echo "Central source verification requires SOURCE_REF to equal the exact checked-out commit" >&2
  exit 1
fi
# shellcheck source=../release/source-layout.sh
source "${controller_root}/release/source-layout.sh"

package="convenewire-central_${version}_source"
archive="${asset_dir}/${package}.tar.gz"
pin_asset="${asset_dir}/${package}.SHA256SUMS.sha256"
if [[ ! -s "${archive}" || ! -s "${pin_asset}" ]]; then
  echo "Missing Central source archive or checksum pin" >&2
  exit 1
fi

temporary_root=""
cleanup() {
  local verifier_status=$?
  local signal=${1:-}
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if [[ -n "${temporary_root}" ]]; then
    rm -rf -- "${temporary_root}"
    if [[ -e "${temporary_root}" || -L "${temporary_root}" ]]; then
      cleanup_status=1
      echo "Failed to remove owned Central verification root: ${temporary_root}" >&2
    fi
  fi
  if [[ -n "${signal}" ]]; then
    kill -s "${signal}" "$$"
    [[ "${signal}" == "INT" ]] && exit 130
    exit 143
  fi
  [[ "${verifier_status}" -eq 0 && "${cleanup_status}" -ne 0 ]] && verifier_status=1
  exit "${verifier_status}"
}
trap cleanup EXIT
trap 'cleanup INT' INT
trap 'cleanup TERM' TERM
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/convenewire-central-source-verify.XXXXXX")
members="${temporary_root}/members"
tar -tzf "${archive}" > "${members}"
if grep -Eq '(^|/)(\.\.?)(/|$)|^/' "${members}"; then
  echo "Central source archive contains an unsafe path" >&2
  exit 1
fi
extraction="${temporary_root}/extracted"
root="${extraction}/${package}"
mkdir -p "${extraction}"
tar -xzf "${archive}" -C "${extraction}"
if find "${root}" -type l -print -quit | grep -q . ||
  find "${root}" ! -type d ! -type f -print -quit | grep -q .; then
  echo "Central source archive contains a symbolic link or non-regular entry" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
pin=$(awk 'NR == 1 && /^[0-9a-f]{64}  SHA256SUMS$/ { print $1 } NR > 1 { invalid = 1 } END { if (invalid || NR != 1) exit 1 }' "${pin_asset}") || {
  echo "Invalid Central checksum pin asset" >&2
  exit 1
}
if [[ "$(sha256_file "${root}/SHA256SUMS")" != "${pin}" ]]; then
  echo "Central internal SHA256SUMS does not match its published pin" >&2
  exit 1
fi
checksum_names=$(awk '
  !/^[0-9a-f]{64}  [A-Za-z0-9.][A-Za-z0-9._+@%\/-]*$/ { invalid = 1 }
  { print $2 }
  END { if (invalid || NR == 0) exit 1 }
' "${root}/SHA256SUMS") || {
  echo "Central internal SHA256SUMS contains an invalid entry" >&2
  exit 1
}
expected_checksum_names=$(find "${root}" -type f ! -name SHA256SUMS -print | sed "s#^${root}/##" | LC_ALL=C sort)
actual_checksum_names=$(printf '%s\n' "${checksum_names}" | LC_ALL=C sort)
if [[ "${actual_checksum_names}" != "${expected_checksum_names}" ]]; then
  echo "Central internal SHA256SUMS is not exhaustive" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  (cd "${root}" && sha256sum -c SHA256SUMS >/dev/null)
else
  (cd "${root}" && shasum -a 256 -c SHA256SUMS >/dev/null)
fi

expected_source="${temporary_root}/expected-source"
mkdir -p "${expected_source}"
git -C "${repository_root}" archive --format=tar "${source_commit}" -- "${central_source_paths[@]}" |
  tar -xf - -C "${expected_source}"
for source_path in "${central_source_paths[@]}"; do
  if ! diff -qr "${expected_source}/${source_path}" "${root}/${source_path}" >/dev/null; then
    echo "Central packaged source differs from ${source_commit}: ${source_path}" >&2
    exit 1
  fi
done
if ! cmp -s "${root}/CENTRAL-INSTALL.md" "${root}/ops/convenewirectl/README.md"; then
  echo "Central install guide differs from the packaged controller guide" >&2
  exit 1
fi

required_generated=(
  convenewire-central-release.json CENTRAL-INSTALL.md
  bin/convenewirectl
  bin/linux_amd64/convenewirectl
  bin/linux_arm64/convenewirectl
  bin/darwin_arm64/convenewirectl
)
for required in "${required_generated[@]}"; do
  if [[ ! -s "${root}/${required}" ]]; then
    echo "Central source archive is missing ${required}" >&2
    exit 1
  fi
done
if [[ ! -x "${root}/bin/convenewirectl" ]]; then
  echo "Central controller launcher is not executable" >&2
  exit 1
fi
for target in linux_amd64 linux_arm64 darwin_arm64; do
  if [[ ! -x "${root}/bin/${target}/convenewirectl" ]]; then
    echo "Central controller helper is not executable: ${target}" >&2
    exit 1
  fi
done

expected_names=$(find "${expected_source}" -type f -print | sed "s#^${expected_source}/##" | LC_ALL=C sort)
for generated in "${required_generated[@]}"; do
  expected_names+=$'\n'"${generated}"
done
expected_names=$(printf '%s\n' "${expected_names}" | LC_ALL=C sort -u)
actual_names=$(find "${root}" -type f ! -name SHA256SUMS -print | sed "s#^${root}/##" | LC_ALL=C sort)
if [[ "${actual_names}" != "${expected_names}" ]]; then
  echo "Central source archive contains missing or unexpected files" >&2
  diff -u <(printf '%s\n' "${expected_names}") <(printf '%s\n' "${actual_names}") >&2 || true
  exit 1
fi
if find "${root}" -type f \( -name '.env' -o -name '*.sqlite' -o -name owner_recovery_token -o -name legacy_server_token -o -name bridge.json \) -print -quit | grep -q .; then
  echo "Central source archive contains forbidden runtime state or credential material" >&2
  exit 1
fi

node - "${root}" "${release_tag}" "${source_commit}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, releaseTag, sourceCommit] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(path.join(root, "convenewire-central-release.json"), "utf8"));
const expectedKeys = ["dataSchemaVersion", "releaseVersion", "schemaVersion", "sourceCommit", "targetArch", "targetOS"];
const migrations = fs.readdirSync(path.join(root, "apps/server/migrations"))
  .map((name) => /^([0-9]{4})_.*\.sql$/.exec(name)).filter(Boolean).map((match) => Number(match[1]));
if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) ||
    value.schemaVersion !== 3 || value.releaseVersion !== releaseTag ||
    value.sourceCommit !== sourceCommit || value.targetOS !== "source" || value.targetArch !== "multi" ||
    !Number.isSafeInteger(value.dataSchemaVersion) || value.dataSchemaVersion !== Math.max(...migrations)) {
  throw new Error("Invalid closed Central source release metadata");
}
NODE

assert_binary_architecture() {
  local binary=$1
  local target=$2
  local description
  description=$(file -b "${binary}")
  case "${target}" in
    linux_amd64) [[ "${description}" =~ ELF.*x86-64 ]] ;;
    linux_arm64) [[ "${description}" =~ ELF.*ARM.aarch64 ]] ;;
    darwin_arm64) [[ "${description}" =~ Mach-O.*arm64 ]] ;;
  esac || {
    echo "Controller architecture mismatch for ${target}: ${description}" >&2
    exit 1
  }
}
escaped_release_tag=${release_tag//./\\.}
for target in linux_amd64 linux_arm64 darwin_arm64; do
  helper="${root}/bin/${target}/convenewirectl"
  assert_binary_architecture "${helper}" "${target}"
  if ! strings "${helper}" | grep -E "${escaped_release_tag}([^0-9A-Za-z._-]|$)" >/dev/null; then
    echo "Central controller omits injected version ${release_tag}: ${target}" >&2
    exit 1
  fi
done
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64|Linux/aarch64|Linux/arm64|Darwin/arm64)
    if [[ "$("${root}/bin/convenewirectl" version)" != "${release_tag}" ]]; then
      echo "Central controller launcher reports the wrong version" >&2
      exit 1
    fi
    ;;
esac

printf 'Verified Central source release for %s\n' "${release_tag}"
