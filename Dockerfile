# mediakiln: optimize the media in a built static site.
#   docker run --rm -v "$PWD/dist:/site" ghcr.io/drk1rd/mediakiln /site
# Mount a cache to make re-runs instant:
#   docker run --rm -v "$PWD/dist:/site" -v "$PWD/.mediakiln-cache:/work/.mediakiln-cache" \
#     ghcr.io/drk1rd/mediakiln /site

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY package.json LICENSE README.md /app/
# Writable for any --user, so the default ./.mediakiln-cache can be created.
RUN mkdir -p /work && chmod 1777 /work
WORKDIR /work
LABEL org.opencontainers.image.source="https://github.com/drk1rd/mediakiln" \
      org.opencontainers.image.description="Optimize video and images in a built static site" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
