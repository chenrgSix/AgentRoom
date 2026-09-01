#!/usr/bin/env bash
set -euo pipefail

state_path=$1
mode=$2
owned_root=""

cleanup() {
  local fixture_status=$?
  local signal=${1:-}
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e
  rm -rf -- "${owned_root}"
  if [[ -e "${owned_root}" || -L "${owned_root}" ]]; then
    cleanup_status=1
  fi
  if [[ -n "${signal}" ]]; then
    kill -s "${signal}" "$$"
    [[ "${signal}" == "INT" ]] && exit 130
    exit 143
  fi
  [[ "${fixture_status}" -eq 0 && "${cleanup_status}" -ne 0 ]] && fixture_status=1
  exit "${fixture_status}"
}
trap cleanup EXIT
trap 'cleanup INT' INT
trap 'cleanup TERM' TERM

owned_root=$(mktemp -d "${TMPDIR:-/tmp}/convene-wire-shell-fixture.XXXXXX")
printf '%s\n' "${owned_root}" > "${state_path}"
case "${mode}" in
  success) exit 0 ;;
  failure) exit 7 ;;
  hold) while true; do sleep 1; done ;;
  *) exit 9 ;;
esac
