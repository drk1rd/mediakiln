#!/usr/bin/env bash
# Generates raw demo media into public/ with ffmpeg (keeps the repo free of binaries).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/media public/img
ff() { ffmpeg -y -hide_banner -loglevel error "$@"; }
[ -f public/media/tour.mp4 ] || ff -f lavfi -i "testsrc2=duration=12:size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=262:duration=12" \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -shortest public/media/tour.mp4
[ -f public/img/cover.jpg ] || ff -f lavfi -i "gradients=size=2400x1600:nb_colors=4:seed=3:duration=1" \
  -frames:v 1 -q:v 1 public/img/cover.jpg
