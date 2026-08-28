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

targets=(darwin/amd64 darwin/arm64 linux/amd64 linux/arm64)
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/agentroom-central-verify.XXXXXX")
cleanup() {
  rm -rf -- "${temporary_root}"
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

assert_binary_architecture() {
  local binary=$1
  local target=$2
  local description
  description=$(file -b "${binary}")
  case "${target}" in
    darwin/amd64) [[ "${description}" =~ Mach-O.*x86_64 ]] ;;
    darwin/arm64) [[ "${description}" =~ Mach-O.*arm64 ]] ;;
    linux/amd64) [[ "${description}" =~ ELF.*x86-64 ]] ;;
    linux/arm64) [[ "${description}" =~ ELF.*ARM.aarch64 ]] ;;
  esac || {
    echo "Controller architecture mismatch for ${target}: ${description}" >&2
    exit 1
  }
}

for target in "${targets[@]}"; do
  target_os=${target%/*}
  target_arch=${target#*/}
  package="agentroom-central_${version}_${target_os}_${target_arch}"
  archive="${asset_dir}/${package}.tar.gz"
  pin_asset="${asset_dir}/${package}.SHA256SUMS.sha256"
  members="${temporary_root}/${package}.members"
  extraction="${temporary_root}/${package}"
  root="${extraction}/${package}"

  if [[ ! -s "${archive}" || ! -s "${pin_asset}" ]]; then
    echo "Missing Central archive or checksum pin for ${target}" >&2
    exit 1
  fi
  tar -tzf "${archive}" > "${members}"
  if grep -Eq '(^|/)(\.\.?)(/|$)|^/' "${members}"; then
    echo "Central archive contains an unsafe path: ${archive}" >&2
    exit 1
  fi
  mkdir -p "${extraction}"
  tar -xzf "${archive}" -C "${extraction}"
  if find "${root}" -type l -print -quit | grep -q .; then
    echo "Central archive contains a symbolic link: ${archive}" >&2
    exit 1
  fi
  if find "${root}" ! -type d ! -type f -print -quit | grep -q .; then
    echo "Central archive contains a non-regular entry: ${archive}" >&2
    exit 1
  fi

  pin=$(awk 'NR == 1 && /^[0-9a-f]{64}  SHA256SUMS$/ { print $1 } NR > 1 { invalid = 1 } END { if (invalid || NR != 1) exit 1 }' "${pin_asset}") || {
    echo "Invalid Central checksum pin asset: ${pin_asset}" >&2
    exit 1
  }
  if [[ "$(sha256_file "${root}/SHA256SUMS")" != "${pin}" ]]; then
    echo "Central internal SHA256SUMS does not match its separately published pin: ${package}" >&2
    exit 1
  fi

  checksum_names=$(awk '
    !/^[0-9a-f]{64}  [A-Za-z0-9.][A-Za-z0-9._+@%\/-]*$/ { invalid = 1 }
    { print $2 }
    END { if (invalid || NR == 0) exit 1 }
  ' "${root}/SHA256SUMS") || {
    echo "Central internal SHA256SUMS contains an invalid entry: ${package}" >&2
    exit 1
  }
  expected_names=$(find "${root}" -type f ! -name SHA256SUMS -print |
    sed "s#^${root}/##" | LC_ALL=C sort)
  actual_names=$(printf '%s\n' "${checksum_names}" | LC_ALL=C sort)
  if [[ "${actual_names}" != "${expected_names}" ]]; then
    echo "Central internal SHA256SUMS is not exhaustive: ${package}" >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "${root}" && sha256sum -c SHA256SUMS >/dev/null)
  else
    (cd "${root}" && shasum -a 256 -c SHA256SUMS >/dev/null)
  fi

  for required in \
    agentroom-central-release.json CENTRAL-INSTALL.md bin/agentroomctl \
    compose.yaml Dockerfile package.json package-lock.json deploy/Caddyfile \
    deploy/tls/public-ca.caddy deploy/tls/private-scoped-ca.caddy deploy/tls/internal-ca.caddy deploy/tls/legacy-auto.caddy deploy/tls/pki-none.caddy \
    scripts/compose-backup.sh scripts/compose-restore.sh \
    LICENSE NOTICE COMMERCIAL-LICENSE.md TRADEMARKS.md; do
    if [[ ! -s "${root}/${required}" ]]; then
      echo "Central archive is missing ${required}: ${package}" >&2
      exit 1
    fi
  done
  if [[ ! -x "${root}/bin/agentroomctl" ]]; then
    echo "Central controller is not executable: ${package}" >&2
    exit 1
  fi
  for license in LICENSE NOTICE COMMERCIAL-LICENSE.md TRADEMARKS.md; do
    if ! cmp -s "${repository_root}/${license}" "${root}/${license}"; then
      echo "Central archive license differs from tagged source: ${package}:${license}" >&2
      exit 1
    fi
  done
  if find "${root}" -type f \( -name '.env' -o -name '*.sqlite' -o -name owner_recovery_token -o -name legacy_server_token -o -name bridge.json \) -print -quit | grep -q .; then
    echo "Central archive contains forbidden runtime state or credential material: ${package}" >&2
    exit 1
  fi

  node - "${root}" "${release_tag}" "${target_os}" "${target_arch}" "${source_commit}" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, releaseTag, targetOS, targetArch, sourceCommit] = process.argv.slice(2);
const filename = path.join(root, "agentroom-central-release.json");
const value = JSON.parse(fs.readFileSync(filename, "utf8"));
const keys = Object.keys(value).sort();
const expected = ["dataSchemaVersion", "releaseVersion", "schemaVersion", "sourceCommit", "targetArch", "targetOS"];
const migrations = fs.readdirSync(path.join(root, "apps/server/migrations"))
  .map((name) => /^([0-9]{4})_.*\.sql$/.exec(name))
  .filter(Boolean)
  .map((match) => Number(match[1]));
const latestMigration = Math.max(...migrations);
if (JSON.stringify(keys) !== JSON.stringify(expected) ||
    value.schemaVersion !== 1 || value.releaseVersion !== releaseTag ||
    !Number.isSafeInteger(value.dataSchemaVersion) || value.dataSchemaVersion !== latestMigration ||
    value.sourceCommit !== sourceCommit ||
    value.targetOS !== targetOS || value.targetArch !== targetArch) {
  throw new Error(`Invalid closed Central release metadata: ${filename}`);
}
NODE

  assert_binary_architecture "${root}/bin/agentroomctl" "${target}"
  escaped_release_tag=${release_tag//./\\.}
  if ! strings "${root}/bin/agentroomctl" | grep -E "${escaped_release_tag}([^0-9A-Za-z._-]|$)" >/dev/null; then
    echo "Central controller omits injected version ${release_tag}: ${package}" >&2
    exit 1
  fi
  if [[ "${target_os}/${target_arch}" == "$(go env GOHOSTOS)/$(go env GOHOSTARCH)" ]]; then
    if [[ "$("${root}/bin/agentroomctl" version)" != "${release_tag}" ]]; then
      echo "Central controller reports the wrong version: ${package}" >&2
      exit 1
    fi
  fi
done

printf 'Verified 4 checksum-pinned Central release archives for %s\n' "${release_tag}"
