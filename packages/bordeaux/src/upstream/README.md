# src/upstream

Files from vercel/board (`packages/board/src/`, Apache-2.0) at the pinned commit, copied byte for byte
by `scripts/vendor-upstream.mjs`, which lists them. Never edit them by hand: rerun the script on an
upgrade and review the diff.

Files that start with `// SHIM (bordeaux)` are ours. Each stands in for an upstream module the vendored
files import but bordeaux doesn't copy (A2, Vercel, or Node-only), re-exporting @vercel/board's public
API wherever it has the same thing.
