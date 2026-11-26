# Releasing

Both packages publish together: `@dosu/bordeaux`, and `@dosu/create-bordeaux`, whose template
depends on it.

1. CI is green on `main`, and you publish from a clean, up-to-date `main`.
2. Set one version in `packages/bordeaux/package.json`, `packages/create-bordeaux/package.json`,
   and the template's `@dosu/bordeaux` dependency (`packages/create-bordeaux/template/package.json`).
   Below 1.0 a caret range pins the minor version, so the template must name the new one.
3. Check what ships: `cd packages/bordeaux && pnpm pack`. `prepack` builds `bdx` into
   `dist/bdx.mjs`, since Node won't run TypeScript from `node_modules`, and copies `LICENSE`
   and `NOTICE` from the repo root. Install the tarball in an empty directory and run
   `npx bdx --help`.
4. Publish both: `npm login`, then `pnpm -r publish --access public`. npm asks you to confirm
   in the browser.
5. Tag the release commit `v<version>`, push the tag, and make a GitHub release from it.
6. Make a board from the published template (`npm create @dosu/bordeaux`) and deploy it.
