#!/bin/zsh

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <source-image> [pad-color-hex]" >&2
  exit 1
fi

source_image="$1"
pad_color="${2:-AAD8C9}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$repo_root/build"
icon_source="$build_dir/icon-source.png"
icon_file="$build_dir/hydra.icns"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/hydra-icon.XXXXXX")"
tmp_square="$tmp_dir/icon-square.png"

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

if [ ! -f "$source_image" ]; then
  echo "Source image not found: $source_image" >&2
  exit 1
fi

width="$(sips -g pixelWidth "$source_image" | awk '/pixelWidth:/ { print $2 }')"
height="$(sips -g pixelHeight "$source_image" | awk '/pixelHeight:/ { print $2 }')"

if [ -z "$width" ] || [ -z "$height" ]; then
  echo "Unable to determine image dimensions for: $source_image" >&2
  exit 1
fi

canvas_size="$width"
if [ "$height" -gt "$canvas_size" ]; then
  canvas_size="$height"
fi

mkdir -p "$build_dir"

sips --padToHeightWidth "$canvas_size" "$canvas_size" --padColor "$pad_color" "$source_image" --out "$tmp_square" >/dev/null 2>&1
sips --resampleHeightWidth 1024 1024 "$tmp_square" --out "$icon_source" >/dev/null 2>&1
sips -s format icns "$icon_source" --out "$icon_file" >/dev/null 2>&1

echo "Generated $icon_source"
echo "Generated $icon_file"
