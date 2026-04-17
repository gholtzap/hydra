#!/usr/bin/env bash

set -uo pipefail

build_env=()
build_args=()
run_env=()
run_args=()

invalid_payload() {
  printf 'Invalid app launch payload.\n'
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --build-env)
      (($# >= 2)) || invalid_payload
      build_env+=("$2")
      shift 2
      ;;
    --build-arg)
      (($# >= 2)) || invalid_payload
      build_args+=("$2")
      shift 2
      ;;
    --run-env)
      (($# >= 2)) || invalid_payload
      run_env+=("$2")
      shift 2
      ;;
    --run-arg)
      (($# >= 2)) || invalid_payload
      run_args+=("$2")
      shift 2
      ;;
    *)
      invalid_payload
      ;;
  esac
done

if ((${#build_args[@]} == 0 || ${#run_args[@]} == 0)); then
  printf 'Build and run commands are required.\n'
  exit 1
fi

print_build_spinner() {
  local build_pid=$1
  local frame_index=0
  local frame

  while kill -0 "$build_pid" 2>/dev/null; do
    case $((frame_index % 4)) in
      0) frame='|' ;;
      1) frame='/' ;;
      2) frame='-' ;;
      3) frame='\\' ;;
    esac

    printf '\r\033[K%s Building...' "$frame"
    sleep 0.1
    frame_index=$((frame_index + 1))
  done
}

printf '\033[2J\033[H'

(env "${build_env[@]}" -- "${build_args[@]}" >/dev/null 2>&1) &
build_pid=$!
print_build_spinner "$build_pid"
wait "$build_pid"
build_status=$?

if [[ "$build_status" -ne 0 ]]; then
  printf '\r\033[KBuilding\nBuild failed (%s).\n' "$build_status"
  exit "$build_status"
fi

printf '\r\033[KBuilding\nBuilt\nNow running...\n'
exec env "${run_env[@]}" -- "${run_args[@]}"
