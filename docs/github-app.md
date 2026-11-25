# The board's GitHub App

A bordeaux board signs people in with GitHub (spec 03). It uses one GitHub App, owned by your
org, for two things:

- **Signing in.** `bx login` runs GitHub's device flow with the App's client ID. The board
  checks that the person is a member of your org, then issues its own tokens. It never keeps
  the person's GitHub token.
- **Signing in to the inspector.** The board's web UI at `/inspect` signs people in with
  GitHub's web flow, which needs the App's client secret and a callback URL. Same org check,
  same tokens.
- **Checking membership again.** When a sign-in renews and its last check is over 12 hours
  old, the board asks GitHub, as the App, whether the person is still in the org. Someone who
  left loses access then. A board with no App credentials can't check, so its people sign in
  again every 12 hours instead.

The same App will carry GitHub sync when that arrives (M3), with more permissions then.

## 1. Create the App

In GitHub, open your org's **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Value |
| --- | --- |
| GitHub App name | anything, e.g. `acme-board` |
| Homepage URL | the board's URL, e.g. `https://board.acme.dev` |
| Callback URL | the board's URL + `/inspect/callback`, e.g. `https://board.acme.dev/inspect/callback` (the inspector's sign-in; `bx login` uses the device flow, which needs none) |
| **Enable Device Flow** | **checked** |
| Webhook → Active | unchecked, for now |
| Organization permissions → **Members** | **Read-only** |
| Where can this GitHub App be installed? | Only on this account |

Members: Read-only is what lets the person's sign-in token, and the App itself, see org
membership. Nothing else is needed for signing in.

After creating it, note the **App ID** and the **Client ID** at the top of its page. Under
**Client secrets**, generate one and copy it. Under **Private keys**, generate one and save
the `.pem` file.

## 2. Install it on the org

On the App's page, choose **Install App** and install it on your org. The installation's URL
ends in its ID: `https://github.com/organizations/acme/settings/installations/12345678`.

## 3. Give the board the App's details

In the board's project (made with `npm create @dosu/bordeaux`):

```bash
# wrangler.jsonc vars: GITHUB_CLIENT_ID is public; BORDEAUX_GITHUB_ORG is your org's login
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_INSTALLATION_ID
npx wrangler secret put GITHUB_PRIVATE_KEY < acme-board.private-key.pem
npx wrangler secret put GITHUB_CLIENT_SECRET   # for the inspector at /inspect
npm run deploy
```

GitHub hands out the private key in PKCS#1 (`BEGIN RSA PRIVATE KEY`). The board takes that or
PKCS#8 as it is.

## 4. Sign in

```bash
npx bx login https://board.acme.dev
```

`bx` prints a code and a GitHub URL. Enter the code there, approve the App, and `bx` is signed
in. In a browser, open `https://board.acme.dev/inspect` (or `/b/<name>/inspect` for a named
board) and sign in with GitHub there. Your org's owners are the board's owners. To make more people owners, set `BORDEAUX_OWNERS`
to their GitHub logins, comma-separated.

## When something's wrong

| What you see | Why |
| --- | --- |
| `this board has no GitHub App to sign in with` | `GITHUB_CLIENT_ID` isn't set |
| `this board has no GitHub org to check members against` | `BORDEAUX_GITHUB_ORG` isn't set |
| `<login> isn't a member of <org> on GitHub` | they aren't, or their membership is pending, or they're an outside collaborator, which doesn't count (as on Vercel) |
| `this board has no GitHub App to sign in to its inspector with` | `GITHUB_CLIENT_SECRET` isn't set |
| GitHub says the redirect URI isn't associated with the App | the App's callback URL isn't `<board URL>/inspect/callback` |
| `can't check you're still in its org without its GitHub App` every 12 hours | the App's secrets aren't set: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` |
