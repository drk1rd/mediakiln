# Releasing

mediakiln is distributed from GitHub only. There is no npm publish. A release is a git tag;
`npx github:drk1rd/mediakiln#vX.Y.Z` and `uses: drk1rd/mediakiln@vX.Y.Z` both resolve to it.

1. Update `CHANGELOG.md`: move items from "Unreleased" under a new `## [X.Y.Z] - YYYY-MM-DD`
   heading.
2. Bump the version: `npm version X.Y.Z --no-git-tag-version` (updates package.json and the
   lockfile).
3. Commit: `git commit -am "Release vX.Y.Z"`.
4. Tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.

The [release workflow](../.github/workflows/release.yml) then:

- checks the tag matches `package.json`,
- creates a GitHub release with that version's CHANGELOG section as notes,
- force-moves the major tag (`v1`) to the new release so `uses: drk1rd/mediakiln@v1` and
  `npx github:drk1rd/mediakiln#v1` pick it up. Pre-releases (`v1.2.0-rc.1`) don't move it,
- builds and pushes the Docker image to `ghcr.io/drk1rd/mediakiln` (tags `X.Y.Z`, `X.Y`, `X`
  and `latest`).

Install-time builds: installing from GitHub runs the `prepare` script, which builds `dist/`
with tsup, so `dist/` is never committed. The GitHub Action installs with `--ignore-scripts`
(skipping the optional `ffmpeg-static` download) and builds explicitly.
