# {{name}}

A [bordeaux](https://github.com/dosu-ai/bordeaux) board for the `{{org}}` GitHub org, at {{url}}.

```bash
npm install
npx wrangler r2 bucket create {{name}}-files
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
npx wrangler secret put GITHUB_INSTALLATION_ID
npm run deploy
npx bx login {{url}}
```

The GitHub App these come from, and how to make it: bordeaux's `docs/github-app.md`.
`npm run dev` runs the board locally with a dev-only sign-in route (`BORDEAUX_DEV=1`), which a
deployed board never has.
