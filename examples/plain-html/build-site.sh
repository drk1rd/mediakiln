#!/usr/bin/env bash
# Builds the finished demo into examples/plain-html/site/: raw site + mediakiln, ready to
# upload to Cloudflare Pages (or any static host serving it from the root):
#   bash examples/plain-html/build-site.sh
#   npx wrangler pages deploy examples/plain-html/site --project-name mediakiln
set -euo pipefail
cd "$(dirname "$0")"
bash build.sh
rm -rf site
cp -R _site site
node ../../dist/cli.js site --config mediakiln.config.json ${MEDIAKILN_SITE:+--site "$MEDIAKILN_SITE"}
echo "ready: $(pwd)/site"
