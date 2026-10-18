#!/usr/bin/env bash
# Builds the example site into _site/ with deliberately unoptimized media:
# a 1080p MP4 with its moov atom at the end, a looping background clip,
# a large JPEG and a PNG. Media is generated with ffmpeg so the repository
# stays free of binaries. Then run:  mediakiln examples/plain-html/_site
set -euo pipefail
cd "$(dirname "$0")"
rm -rf _site
mkdir -p _site/media _site/img
cp -R src/. _site/

ff() { ffmpeg -y -hide_banner -loglevel error "$@"; }

# 20 s of 1080p30 with audio: long enough for HLS.
ff -f lavfi -i "testsrc2=duration=20:size=1920x1080:rate=30" \
   -f lavfi -i "sine=frequency=330:beep_factor=4:duration=20" \
   -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -c:a aac -shortest \
   _site/media/intro.mp4

# 4 s silent loop for an autoplay background: stays MP4-only.
ff -f lavfi -i "mandelbrot=size=1280x720:rate=30" -t 4 \
   -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p _site/media/loop.mp4

# A 2400x1350 hero photo-like image and an 1200x800 PNG.
ff -f lavfi -i "gradients=size=2400x1350:nb_colors=5:seed=7:duration=1" -frames:v 1 -q:v 1 _site/img/hero.jpg
ff -f lavfi -i "cellauto=size=1200x800:rule=110:rate=1" -frames:v 1 _site/img/pattern.png

echo "built $(pwd)/_site"
