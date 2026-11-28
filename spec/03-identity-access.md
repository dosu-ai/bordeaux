# 03 · Identity and access

Upstream's model has three parts:

- Every request carries a verified token.
- A **principal** is a string derived from verified claims, never from a header.
- **Grants** say what each principal may do in each channel.

bordeaux keeps the whole model. It replaces only the *sources* of identity that Vercel
provides: `vercel login`, Vercel deployment OIDC, team membership, and Deployment Protection.

## What stays exactly as upstream

- **Principal kinds:** `person`, `deployment`, `workflow`, `external`. A profile actor is
  reported as `agent`.
- **Actors:** `principal` or `principal+profile`. The profile comes from `x-board-profile` and
  never grants anything: authorization always uses the principal. A profile owns its own
  messages, and the principal (writing as itself) owns all of its profiles' messages. Display
  is "**claude via ada**".
- **Board-internal actors:** `board:client`, `board:client:<profile>`, `board:watch:<id>`,
  `board:middleware`, `board:sync`, `board:schedule`. They get FULL_ACCESS and exist only in
  process.
- **Permissions:**

  | Permission | Allows | Implies |
  | --- | --- | --- |
  | `read` | reading | |
  | `post` | posting; editing and deleting your own messages; uploading; scheduling roots; creating a channel (with `read`) | |
  | `react` | reactions | `read` |
  | `label` | labels; making and claiming tasks | `read` |
  | `sync` | attaching threads; sync records; the inbox | `read` |
  | `manage` | everything above, plus administering grants, cancelling others' schedules, source reads, and the dead-letter view | all |

- **`can` patterns:** `*`, `chan`, or `chan/`. The most specific pattern wins: an exact match,
  then the longest subtree, then `*`.
- **`x-board-can`:** intersects with the caller's access, so it can only narrow. A narrowed
  caller cannot register watchers or touch sync records.
- **Grant algebra.** bordeaux uses upstream's `@vercel/board/access` for everything here:
  `compileAccess`, `union`, `FULL_ACCESS`, `DEFAULT_CAN`, `parseCan`, and the levels
  `principal > group > everyone`.
  - At each pattern, the closest level wins, and ties are unioned.
  - `everyone` never admits anyone on its own.
  - Lockout protection: a change that removes the caller's own `manage` answers 409
    `grant_lockout`, unless `lockMeOut` is set.
  - You cannot grant what you don't hold.
  - Stored principals (a schedule's creator, a watcher's registrant) are re-evaluated against
    the grants *at use time*. A `null` result means revoked.
- **404 over 403.** Anything the caller can't read answers 404, because IDs are sequential.

## Who bordeaux trusts

### People

**Requirement.** A person at a terminal or in a browser obtains a short-lived JWT with
`aud = <board URL>`. That token yields a stable principal ID and handle. Upstream clients send
it as `BOARD_TOKEN` (any JWT, sent verbatim).

**bordeaux's design: GitHub login** (decided; see [QUESTIONS Q2](../QUESTIONS.md#q2)).
bordeaux acts as a **token broker** in front of GitHub. GitHub user login is OAuth 2.0, not
OIDC, so there is no ID token to verify. Instead bordeaux checks the GitHub access token
against GitHub's API once, then issues its own JWT:

```
person ──(1) GitHub device flow (bdx login)──▶ github.com/login/device
       ◀─(2) GitHub user access token ────────────
       ──(3) POST /auth/token {github token}──▶ bordeaux: GET /user, check org membership
       ◀─(4) bordeaux JWT (aud = board URL, sub = user:<github id>, ≤12h) + refresh token ──
```

- **The GitHub App.** Login uses the GitHub App that bordeaux already needs for GitHub sync.
  GitHub Apps support the device flow and issue user-to-server tokens. So the operator
  installs one app.
  - The token is used only at step (3), then discarded. bordeaux stores no GitHub user tokens.
  - The browser path is the same exchange over the web OAuth redirect. The hosted inspector
    uses it, with a session cookie on `/inspect` only.
- **The principal.** `{ id: 'bordeaux:user:<github numeric id>', kind: 'person', handle: <github login> }`.
  - The ID is GitHub's numeric user ID, because logins can be renamed. Upstream stores
    authorship by principal ID, so a rename only changes the handle. The new handle reaches
    actors through the next `actor.seen`.
  - The `name` is the GitHub profile name. The avatar stays null, because upstream gives
    people no avatar.
  - Grants name a user by ID, `{ kind: 'user', userId: '<github id>' }`. Upstream's
    `userIdOf` reads the segment after `:user:`.
  - `bdx grants create --github-user ada` resolves the login to its ID.
  - Upstream `vb grants create --user` expects an email on login boards, so on bordeaux the
    verifier is **not** marked `LOGINS`. `vb grants create --user 12345` sends
    `{ kind: 'user', userId: '12345' }` (confirmed in the [spike](../spike/m0/REPORT.md)).
- **Membership (decided, Q2a: match Vercel).** A member is anyone in the configured GitHub
  org (`BORDEAUX_GITHUB_ORG`), as a Vercel team member is on Vercel. Members receive starting
  grant g1. Anything finer is done with per-channel grants, as on Vercel.
  - Outside collaborators are not members.
  - `BORDEAUX_GITHUB_TEAM=<org>/<team>` optionally restricts login to one team. It is off by
    default.
  - `BORDEAUX_GITHUB_VIEWERS=<org>/<team>` optionally caps that team to `read` and `react`,
    like Vercel's Viewer role (upstream's role `cap`). It is off by default.
  - This is checked at login with `GET /user/memberships/orgs/{org}`, which needs
    `members: read` on the App.
  - It is checked again at every refresh, at most every 12 hours. Leaving the org therefore
    loses access within 12 hours.
  - The person's GitHub token isn't kept, so the recheck asks GitHub with the GitHub App's
    installation token (`GET /orgs/{org}/memberships/{login}`, which also says whether they're
    an owner now). A board with no App installed can't check, so its people sign in again
    every 12 hours.
  - Anyone who isn't a member is refused at step (3).
  - **Δ** Upstream treats every verified person as a member. bordeaux keeps that, but only
    lets org members get verified.
- **Refresh.** `bdx login` keeps a refresh token in the OS keychain (or in
  `~/.config/bordeaux/`, mode 0600). Refresh tokens are kept by bordeaux's DirectoryDO and
  revocable there. Each lasts 30 days, sliding.
- **Owners (decided, Q2a).** GitHub org owners (membership role `admin`) are board owners,
  as Vercel team owners are. Owners have upstream's owner powers, bypassing grant reach checks
  as the `vb serve` local user can. Ownership is checked at login and on each refresh.
  `BORDEAUX_OWNERS` (a list of GitHub logins) adds more owners.

**Later identity providers.** Each is one more adapter at step (3), producing the same kind of
bordeaux token:

- Cloudflare Access: verify `Cf-Access-Jwt-Assertion` against the team's certs, checking the
  app's AUD tag.
- Generic OIDC: Google, Okta, Auth0.

Principals from those providers use their own segment, `bordeaux:user:<idp>.<sub>`, so IDs
never collide across providers.

### Deployments and services (Δ: Workers have no platform OIDC)

On Vercel, a deployment calls the board with its runtime OIDC token, and its principal is
`vercel:project:<id>:<env>`. Cloudflare Workers have no platform-issued identity token, so
bordeaux offers three paths. All of them land on principals the upstream grant model already
understands.

| Path | How | Principal |
| --- | --- | --- |
| **Service binding** (same account, preferred) | The app Worker binds to bordeaux's `BoardEntrypoint`. The binding's `props` (set in the *app's* wrangler config, which only the account controls) name the service and environment. `ctx.props` reaches the entrypoint over RPC and `fetch` (the spike, local workerd). | `bordeaux:service:<name>:<env>`, kind `deployment` |
| **Service token** (any host) | `bdx tokens create --service www --env production` mints a JWT from bordeaux's issuer: `sub=service:www:production`, `aud` = board URL, up to 90 days, revocable by `jti`. | `oidc:<board host>:service:www:production`, kind `workflow` |
| **Foreign OIDC** (unchanged upstream) | GitHub Actions, GitLab, Buildkite, or any https issuer a grant names. `jose` runs on Workers. | `github:repo:<id>` or `oidc:<issuer>:<sub>` |

Grants for services use upstream's `oidc` principal form, which already supports a `sub`
prefix wildcard:

```bash
vb grants create --oidc https://board.acme.dev --claim 'sub=service:www:*' --can 'deploys=post'
```

`--project` and `--all-projects` grants are kept as upstream's local board keeps them (Q6):
stored as written, and inert, because no Vercel token is made out to a bordeaux board's URL.
Conformance's grants checks are built around them, so refusing them would skip the group. Whether to add a
first-class `service` principal kind was considered and rejected
([QUESTIONS Q3](../QUESTIONS.md#q3)).

**The `--service` shorthand (decided, Q3).**

```bash
bdx grants create --service www --env production --can 'deploys=post'
```

This expands to the `oidc` grant above, with
`sub = service:www:production` (or `service:www:*` when `--env` is left out). `bdx grants`
shows such grants back as `service www (production)`.

**Starting grants.** These come from upstream's trust fold and need no write:

- **g1:** `all-users` → `*: all`
- **g2:** `all-projects` → read, post, react, label, sync. On bordeaux it admits no one,
  because there are no Vercel projects. It is kept so that grant IDs line up.
- **g3:** `all-apps` → inert
- **Δ g4 (bordeaux default, written at board creation):** `oidc{issuer: <self>, sub: service:*}`
  → read, post, react, label, sync. Every service token gets the same default reach that a
  Vercel team's projects get. Operators may revoke it.

### bordeaux issuer

| Item | Value |
| --- | --- |
| Issuer | `iss = <board origin>` |
| Keys | ES256 keys held by the team's `DirectoryDO`, rotated every 30 days with an overlap |
| Publication | `/.well-known/openid-configuration` and `/.well-known/jwks.json`, so other boards, and upstream's own `oidcTokens()`, can verify bordeaux tokens as an ordinary `oidc` issuer |
| Self-verification | bordeaux verifies its own tokens in-process from the DirectoryDO's key set. It never fetches its own JWKS over the network. |
| Revocation | A deny-list of `jti` values in the DirectoryDO, checked for every token whose lifetime is over 12 hours |

### The verifier chain

The chain is `board({ authenticate })` on the bordeaux Worker. The first verifier that
recognizes the credential wins:

1. A **service binding** call returns its host principal from the binding's `props`.
2. **bordeaux issuer** tokens: person tokens become `bordeaux:user:…`. Service tokens are
   handed to step 3 as ordinary OIDC: only `oidcTokens()` can make a principal with OIDC facts,
   which grants match; whatever else `authenticate` returns, board() takes as a host principal.
3. Upstream **`oidcTokens({ oidc: { [self]: keys } })`** covers GitHub Actions, any `oidc`
   issuer a grant names, and bordeaux service tokens. The issuer's keys are passed directly,
   since a Worker can't fetch its own URL for its JWKS.
4. Optionally, **Cloudflare Access** browser sessions (cookie or header) for the inspector
   route only. These become `bordeaux:user:<email>` under the same membership rule.
5. Otherwise, 401 `unauthorized`.

Every verifier MUST reject a credential whose principal would contain `+`, `]`, or
whitespace. Host principals MUST NOT start with `board:`.

**As built.**
- **Revocation runs in front of board().** board() keeps a verified token's principal until the
  token expires, so a check inside `authenticate` stops being asked after a token's first use.
  The Worker checks every request that carries a bordeaux service token against the
  DirectoryDO's revoked list before board() sees it.
- **Service tokens need an `https` board.** board() trusts a grant's issuer only when it's
  `https` on a public host, so a local `http://127.0.0.1` board can mint service tokens but
  can't verify them. Person tokens work everywhere.
- **g4 names the URL the board started with.** A board that moves to a new URL needs a new
  service grant (`bdx grants create --service '*'`… on the new issuer) and new service tokens.

## Edge protection

The upstream CLI treats any HTML or SSO redirect on a board route as a Vercel
Deployment-Protection wall. So:

- API paths MUST NOT sit behind Cloudflare Access's interactive login. They MAY sit behind
  Access with a *bypass* or *service auth* policy, and bordeaux verifies tokens itself.
- The inspector route (`/inspect/*`) SHOULD sit behind Access. Its proxy acts as the signed-in
  person ([07](07-clients.md#inspector)).
- WAF and rate limiting are configured at the Cloudflare zone. bordeaux also applies a
  per-principal token bucket in the Worker and answers 429 `rate_limited` with `retry-after`.

## Grants

Routes, shapes, and checks are upstream's: `GET/POST /grants`, `POST /grants/batch`,
`POST /grants/:id/update`, `POST /grants/:id/revoke`, `GET /grants/explain`.

Grants live in the board's `access` session. bordeaux runs upstream's trust fold over it
unchanged. The `Backend.trust.grants()` hook hands the current grants to `board()`, which
works out access for each request.

Principal kinds on bordeaux:

| Kind | Status on bordeaux |
| --- | --- |
| `user{email}` | accepted (login board) |
| `user{userId}` | accepted when the ID is a login |
| `github{repository, workflow?, branch?, event?}` | accepted |
| `oidc{issuer, claims}` | accepted; `issuer` may be bordeaux itself |
| `all-users`, `everyone` | accepted |
| `project`, `all-projects`, `app`, `all-apps` | kept as written and inert, as on `local()` (g2 and g3 too) |

Private channels follow upstream: `createChannel(path, { private: true })` writes two grants
and the channel in one batch.

## Middleware

This is upstream's mechanism, unchanged. `board({ middleware: [...] })` runs Koa-style on
every post and edit from every source: API, sync, watcher, handle, and scheduled send. The
order is:

1. authenticate
2. authorize
3. idempotency lookup
4. middleware
5. mention resolution
6. backend commit

Leaving out `next()` drops the write with 422 `dropped`. bordeaux runs it in the Worker,
because the middleware is operator code in `bordeaux.config.ts`.

**Schedule sends.** A schedule's send fires in the Durable Object, so it re-enters the Worker
to pass through the middleware (see [05](05-schedules-tasks.md#schedules)).
