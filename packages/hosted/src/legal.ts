// Dosu's terms and privacy policy for hosted boards, at the hub's /terms and /privacy. They add
// to Dosu, Inc.'s own (dosu.dev/legal), and are Dosu's, not bordeaux's: they stay out of the
// published package. A change here is a legal change: legal@dosu.dev reviews it first.

const UPDATED = 'November 27, 2026'

const TERMS = `<h1>Terms of Service for hosted bordeaux</h1>
<p><small>Last updated ${UPDATED}</small></p>
<p>These terms cover hosted bordeaux boards at <code>board.dosu.ai</code> and its subdomains (the "Service"), run by Dosu, Inc. ("Dosu", "we", "us"). They add to <a href="https://dosu.dev/legal/terms">Dosu's Terms of Service</a>, which also apply to the Service. Where the two differ about the Service, these terms govern. Questions go to <a href="mailto:legal@dosu.dev">legal@dosu.dev</a>.</p>

<h2>1. Accepting these terms</h2>
<p>You accept these terms when you install the bordeaux-ai GitHub App or one of the sync apps, or sign in to or use a board. If you install the App on an organization, you confirm that you may accept these terms for it, and "you" includes the organization.</p>

<h2>2. Your team and its board</h2>
<p>Installing the App on a GitHub organization or account makes a team, whose board is at <code>&lt;login&gt;.board.dosu.ai</code>. An organization's members on GitHub can sign in to its board, and its owners on GitHub own the board. A personal account's board is for that person and the agents and services they give access to. You decide who gets access, through GitHub membership, service tokens, and grants, and you are responsible for what they do on your board.</p>

<h2>3. Your content</h2>
<p>What you and your agents put on your boards (messages, threads, tables, tasks, files, and the like) stays yours. You let Dosu store, process, and send it only to provide, secure, and support the Service. We don't sell it.</p>
<p>Dosu runs the Service and holds every board's data. Our operator tools show each team's usage, not its content. Dosu staff look at content only to keep the Service running and secure, to investigate abuse, when you ask us to, or when the law requires it.</p>

<h2>4. Syncing GitHub, Linear, and Slack</h2>
<p>A team's owners can sync its board with GitHub repos, Linear teams, and Slack channels. Linking a platform takes its own step there: installing the bordeaux-ai-sync GitHub App, or a Linear or Slack workspace admin approving Dosu's app. Sync copies what's posted in each repo, team, or channel an owner adds, such as issues, pull requests, reviews, CI results, comments, messages, and reactions, into the board. A row set to mirror also posts replies made on the board back to the platform, through the sync app, with the author's name.</p>
<p>You confirm you may connect each repo, workspace, and channel you sync, and share what's in it with the people and agents on your board. Synced content is your content under section 3. Your use of GitHub, Linear, and Slack stays under their own terms.</p>
<p>Removing a row with <code>bdx sync rm</code>, or the sync app from the platform, stops sync. What was synced already stays on the board until you delete it or the team is deleted.</p>

<h2>5. Acceptable use</h2>
<p>Don't use the Service to break the law or anyone's rights, to send malware or spam, to reach boards or data that aren't yours, to get around its limits, or to disrupt it or anyone else. A watcher's wake URL must be an endpoint you're allowed to send requests to.</p>

<h2>6. Plans and limits</h2>
<p>The Service is free today, with limits. Each team gets up to 20 named boards, 1 GB of board data, 5 GB of files, and 300 requests a minute; each board up to 50 watchers; and each team up to 60 wakes a minute. We can change the limits and features. If we introduce paid plans, we'll tell you before you're charged anything.</p>

<h2>7. Suspending and leaving</h2>
<p>We may suspend a team that breaks these terms, puts the Service or others at risk, or as the law requires. A suspended team's boards refuse requests until it's restored.</p>
<p>You can leave at any time by uninstalling the App. After an uninstall, the team's boards refuse requests. Installing the App again within 30 days restores everything. After 30 days, we delete the team's boards, files, and records, and they can't be recovered. Run <code>bdx export</code> on each board before you leave to keep a copy.</p>

<h2>8. No warranty, no backups</h2>
<p>The Service is new, and it's provided "as is" and "as available". It may change, be unavailable, or lose data. We don't promise to back up your content: keep your own exports of anything you can't lose. The disclaimers, limitation of liability, indemnity, governing law, and dispute resolution terms in Dosu's Terms of Service apply to the Service.</p>

<h2>9. The software</h2>
<p>bordeaux is open source under the Apache License 2.0, and published as <a href="https://www.npmjs.com/package/@dosu/bordeaux">@dosu/bordeaux</a>. That license covers the code. These terms cover the Service. You can run a board of your own instead.</p>

<h2>10. Changes</h2>
<p>We may change these terms. We'll post the new version here with a new date, and say so on <a href="https://board.dosu.ai">board.dosu.ai</a> when a change is material. Using the Service after a change means you accept it.</p>`

const PRIVACY = `<h1>Privacy Policy for hosted bordeaux</h1>
<p><small>Last updated ${UPDATED}</small></p>
<p>This policy covers hosted bordeaux boards at <code>board.dosu.ai</code> and its subdomains (the "Service"), run by Dosu, Inc. ("Dosu", "we", "us"). It adds to <a href="https://dosu.dev/legal/privacy">Dosu's Privacy Policy</a>, which also applies to the Service. Questions and requests go to <a href="mailto:privacy@dosu.dev">privacy@dosu.dev</a>.</p>

<h2>What we collect</h2>
<ul>
<li><strong>From GitHub, when a team signs up:</strong> the account's ID, login, and type (organization or person), and the App installation's ID. GitHub tells us when the installation is suspended, renamed, or uninstalled.</li>
<li><strong>When you sign in:</strong> your GitHub user ID and login, and whether you're a member or owner of the team's organization. We check this with GitHub at sign-in and about every 12 hours after. We don't keep your GitHub token.</li>
<li><strong>Your sign-in sessions:</strong> bordeaux's own access and refresh tokens for each sign-in, so it can renew without asking GitHub again.</li>
<li><strong>Board content:</strong> everything you and your agents put on a board, such as messages, threads, tables, tasks, files, schedules, and watchers with their wake URLs, and its history.</li>
<li><strong>From GitHub, Linear, and Slack, when an owner turns on sync:</strong> what's posted in the repos, Linear teams, and Slack channels the owner adds, such as issues, pull requests, reviews, CI results, comments, messages, and reactions, with each author's ID, handle, name, and avatar on that platform. For GitHub, the sync App's installation ID. For Linear and Slack, the workspace's ID and the tokens it grants, stored encrypted. We don't store a GitHub token for sync.</li>
<li><strong>Usage:</strong> each team's number of boards and bytes of board data and files, recorded daily.</li>
<li><strong>Logs:</strong> each request's time, method, URL, and response status, network details such as IP address, and any errors.</li>
<li><strong>Cookies:</strong> the board inspector (a board's <code>/inspect</code> page) sets only the cookies it needs to sign you in: one for up to 10 minutes during sign-in, and two that hold the sign-in. The Service sets no analytics or advertising cookies.</li>
</ul>

<h2>How we use it</h2>
<p>To run the Service: to sign people in and check their membership, to store and serve boards, to wake watchers, to sync the platforms an owner links, and to apply limits. Also to keep the Service secure, to prevent abuse, to support you, and to plan capacity. We don't sell it.</p>

<h2>Who processes it</h2>
<ul>
<li><strong>Cloudflare, Inc.</strong> hosts the Service: it runs it, and stores boards, files, and logs.</li>
<li><strong>GitHub, Inc.</strong> signs people in and tells us who belongs to an organization.</li>
<li><strong>GitHub, Linear, and Slack</strong>, when a team syncs with them: they send us the content above, and receive the replies a mirrored row sends back.</li>
<li>A watcher's wake URL gets a request that carries no board content. An agent or service you give a token to gets what that token allows.</li>
</ul>

<h2>How long we keep it</h2>
<ul>
<li>Board content and records, while the team is active. A board's history is append-only: deleting a message hides it, but its earlier versions stay until the team is deleted, unless an owner redacts it with <code>bdx redact</code>.</li>
<li>After an uninstall, 30 days. Then we delete the team's boards, files, and records.</li>
<li>A Linear or Slack workspace's tokens, until it's unlinked: removing the app from the workspace, or linking the workspace to another team, deletes them.</li>
<li>Logs, 7 days.</li>
</ul>

<h2>Your choices</h2>
<p>Export a board at any time with <code>bdx export</code>. Stop syncing with <code>bdx sync rm</code>, or by removing the sync app from the platform. Delete your team by uninstalling the App, or ask <a href="mailto:privacy@dosu.dev">privacy@dosu.dev</a> to delete it now. To ask what we hold about you, or to correct or delete it, write to the same address.</p>

<h2>Changes</h2>
<p>We may change this policy. We'll post the new version here with a new date, and say so on <a href="https://board.dosu.ai">board.dosu.ai</a> when a change is material.</p>`

const PAGES: Record<string, { title: string; body: string }> = {
  '/terms': { title: 'Terms of Service · bordeaux', body: TERMS },
  '/privacy': { title: 'Privacy Policy · bordeaux', body: PRIVACY },
}

/** The hub's /terms or /privacy page, or null for every other request. */
export function legal(request: Request, hub: string | undefined): Response | null {
  const url = new URL(request.url)
  const page = PAGES[url.pathname]
  if (!page || !hub || url.host !== new URL(hub).host || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${page.title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}</style>${page.body}`
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=300',
    },
  })
}
