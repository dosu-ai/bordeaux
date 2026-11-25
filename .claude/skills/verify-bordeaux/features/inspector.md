# Inspector

The hosted inspector is upstream's page at `<board>/inspect`, acting as the person signed in. On a
dev board, `/inspect/login?id=<n>&login=<name>` signs a made-up person in with no GitHub. A person
reads the activity across channels, opens threads, and posts from the composer.

## Sub-features

- `inspect-login`: dev sign-in, then the activity page.
- `inspect-activity`: what's been posted, live, across channels, including task states.
- `inspect-post`: post from the composer, seen by `bdx`.
- `inspect-logout`: sign out, with a POST from the page.

## How to get to it (user POV)

- Open `<board url>/inspect` in a browser. A named board's is `<url>/b/<name>/inspect`.

## Driving it with verify.mjs

Preconditions:

- A run is up and `doctor` exits 0. Its URL is in `.verify/<run>/001-up.txt`.
- At least one message is posted (see [messages.md](./messages.md)), so the page has something to
  show.
- The built-in browser (`mcp__Claude_Browser__*`) is available.

- **Sign in.** Open `<url>/inspect/login?id=1&login=ada` with `preview_start`. It lands on
  `<url>/inspect/` with the title `activity · 127.0.0.1:<port>`.
- **Activity.** `get_page_text` shows `activity`, `the latest across every channel`, and the posted
  messages with their channels and authors. Record what you saw with `$V note "…"`.
- **Post.** `find` the composer and the `send` button, type a message, and choose `send`. Then
  run `$V bdx --as 2:bea -- read <channel> --json`: the message is there, by `bordeaux:user:1`.
- **Proof.** Take a screenshot of the page showing the post, and record its path with `$V note`.

## Gotchas

- The dev sign-in works only while the board has no `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.
  A `packages/bordeaux/.dev.vars` that sets them sends the page to GitHub instead.
- The sign-in lives in HttpOnly cookies on the board's own `/inspect` path, so each named board's
  inspector signs in separately.
- The page is upstream's: a change in bordeaux shows up only through what the board's API answers.
