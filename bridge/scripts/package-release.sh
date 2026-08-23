#!/usr/bin/env bash
set -euo pipefail

bridge_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${OUTPUT_DIR:-"${bridge_root}/dist"}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
goos=${GOOS:?GOOS is required}
goarch=${GOARCH:?GOARCH is required}
version=${release_tag#v}

if [[ ! "${version}" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "Release tag must contain only letters, numbers, dots, underscores, and hyphens" >&2
  exit 1
fi

case "${goos}/${goarch}" in
  darwin/amd64|darwin/arm64|linux/amd64|linux/arm64)
    archive_format=tar.gz
    ;;
  windows/amd64)
    archive_format=zip
    ;;
  *)
    echo "Unsupported Bridge release target: ${goos}/${goarch}" >&2
    exit 1
    ;;
esac

package="agentroom-bridge_${version}_${goos}_${goarch}"
staging="${output_dir}/${package}"
binary=agentroom-bridge
if [[ "${goos}" == windows ]]; then
  binary=agentroom-bridge.exe
fi

mkdir -p "${staging}"
(
  cd "${bridge_root}"
  CGO_ENABLED=0 GOOS="${goos}" GOARCH="${goarch}" go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${release_tag}" \
    -o "${staging}/${binary}" \
    ./cmd/agentroom-bridge
)
cp "${bridge_root}/README.md" "${staging}/README.md"

host_os=$(go env GOHOSTOS)
host_arch=$(go env GOHOSTARCH)
if [[ "${goos}/${goarch}" == "${host_os}/${host_arch}" ]]; then
  built_version=$("${staging}/${binary}" version)
  if [[ "${built_version}" != "${release_tag}" ]]; then
    echo "Built Bridge reports ${built_version}, expected ${release_tag}" >&2
    exit 1
  fi
fi

case "${goos}" in
  darwin)
    cp "${bridge_root}/release/start-agentroom-bridge.command" \
      "${staging}/Start AgentRoom Bridge.command"
    chmod +x "${staging}/Start AgentRoom Bridge.command"
    ;;
  linux)
    cp "${bridge_root}/release/start-agentroom-bridge.sh" \
      "${staging}/start-agentroom-bridge.sh"
    chmod +x "${staging}/start-agentroom-bridge.sh"
    ;;
  windows)
    cp "${bridge_root}/release/start-agentroom-bridge.cmd" \
      "${staging}/Start AgentRoom Bridge.cmd"
    ;;
esac

mkdir -p "${output_dir}"
if [[ "${archive_format}" == zip ]]; then
  (cd "${output_dir}" && zip -qr "${package}.zip" "${package}")
  printf '%s\n' "${output_dir}/${package}.zip"
else
  tar -C "${output_dir}" -czf "${output_dir}/${package}.tar.gz" "${package}"
  printf '%s\n' "${output_dir}/${package}.tar.gz"
fi
