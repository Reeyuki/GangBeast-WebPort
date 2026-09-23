# GangBeast Web Port

Unity WebGL build for GitHub Pages. Enable Pages from the `main` branch, `/ (root)`.

The Unity data package is split into 20 MiB parts under `Build/data-*` because the original file exceeds GitHub's 100 MiB file limit. `game-data.js` downloads the parts in order and passes the complete package to Unity. Keep every part listed in `Build/data-manifest.json`.

The page uses the uncompressed JavaScript and WebAssembly files, so it does not require custom Brotli response headers. The `.br` files are not used by this page.

For a local preview, serve this directory over HTTP; do not open `index.html` as a `file://` URL.
