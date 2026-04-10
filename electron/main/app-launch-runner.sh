#!/bin/sh

BUILD_COMMAND=${1-}
RUN_COMMAND=${2-}

if [ -z "$BUILD_COMMAND" ] || [ -z "$RUN_COMMAND" ]; then
  printf 'Build and run commands are required.\n'
  exit 1
fi

print_build_spinner() {
  build_pid=$1
  frame_index=0

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

(eval "$BUILD_COMMAND") >/dev/null 2>&1 &
build_pid=$!
print_build_spinner "$build_pid"
wait "$build_pid"
build_status=$?

if [ "$build_status" -ne 0 ]; then
  printf '\r\033[KBuilding\nBuild failed (%s).\n' "$build_status"
  exit "$build_status"
fi

printf '\r\033[KBuilding\nBuilt\nNow running...\n'
eval "$RUN_COMMAND"
exit $?
