#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'Skipping macOS icon generation on non-macOS host.\n'
  exit 0
fi

swift "$SCRIPT_DIR/generate-icon.swift"
iconutil --convert icns "$SCRIPT_DIR/icon.iconset" --output "$SCRIPT_DIR/icon.icns"

printf 'Generated %s\n' "$ROOT_DIR/build/icon.icns"
