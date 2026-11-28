// SHIM (bordeaux): upstream's src/version.ts reads its own package.json, which isn't beside the
// vendored files. This is the version they were copied from (PIN in scripts/vendor-upstream.mjs).
export const VERSION: string = '0.57.0'
