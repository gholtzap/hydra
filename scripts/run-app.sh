#!/bin/zsh
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR="$ROOT_DIR/.dist/ClaudeWorkspace.app"

"$ROOT_DIR/scripts/build-app.sh"
open "$APP_DIR"
