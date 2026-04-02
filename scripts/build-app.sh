#!/bin/zsh
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
BUILD_DIR="$ROOT_DIR/.build"
DIST_DIR="$ROOT_DIR/.dist"
APP_DIR="$DIST_DIR/ClaudeWorkspace.app"
EXECUTABLE="$BUILD_DIR/debug/ClaudeWorkspace"
RESOURCE_BUNDLES=$(find "$BUILD_DIR" -maxdepth 4 -type d -name '*.bundle' | sort)

export HOME="$ROOT_DIR"
export CLANG_MODULE_CACHE_PATH="$BUILD_DIR/ModuleCache"
export SWIFTPM_CUSTOM_CACHE_PATH="$BUILD_DIR/swiftpm-cache"

cd "$ROOT_DIR"
swift build --disable-sandbox

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$ROOT_DIR/packaging/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$EXECUTABLE" "$APP_DIR/Contents/MacOS/ClaudeWorkspace"
chmod +x "$APP_DIR/Contents/MacOS/ClaudeWorkspace"

for bundle in $RESOURCE_BUNDLES; do
  cp -R "$bundle" "$APP_DIR/Contents/Resources/"
done

echo "Built $APP_DIR"
