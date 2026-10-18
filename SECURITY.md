# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through
[GitHub security advisories](https://github.com/drk1rd/mediakiln/security/advisories/new)
instead, with the mediakiln version, how to reproduce it and what an attacker could do with it.

You'll get a reply within a week. Once a fix is ready, it ships in a patch release and the
advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets fixes. The major tag (`v1`) used by the Action and by
`npx github:drk1rd/mediakiln#v1` moves to each new release, so those pick up a fix
automatically; pinned tags and Docker image versions need a manual update.

## Scope

mediakiln runs at build time on files you already control, and passes them to ffmpeg and Sharp.
Vulnerabilities in ffmpeg, libvips or Sharp themselves should go to those projects; a way
for mediakiln to pass them input or arguments it shouldn't (for example a crafted HTML file that
makes it read or write outside the site directory) is in scope. So is anything in the runtime
script and hls.js copy that mediakiln adds to your pages.
