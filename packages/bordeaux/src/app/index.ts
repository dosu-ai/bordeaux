// `@dosu/bordeaux/app`: the Backend an app passes to upstream's board() to use a bordeaux board
// (spec 07, and spec 04 "Wake-ups without Vercel"):
//
//   const team = board({ backend: bordeaux({ url: env.BOARD_URL, token: env.BOARD_TOKEN, publicUrl }), watch })
//   export default { fetch: team.fetch }   // serves POST /wake and POST /watchers
//
// The protocol is upstream's http() backend, vendored as it is (src/upstream/server/backend-http.ts):
// every method forwards to the board, and a post a watcher or a trigger makes gets a
// `key:<principal>:` ID there, so a retry posts once. What's ours is how watchers run. http() runs
// them as tails in its own process, which a Worker doesn't keep; vercel() registers them with
// Vercel's API, which wakes a path on its project. This registers them with the board, which wakes
// `<publicUrl>/wake` (Δ: bordeaux answers `path` with 501 `no_wake_by_path`). The rest is upstream's
// registrant() (src/upstream/server/registrant.ts), restated here because it decides between being
// woken and pulling by whether a registration has a `path`, which one woken by URL never has.
import type { Backend, BackendRoute, BoardBinding, Caller, MatchView, ProtocolMethods, RegistrationView, SelfCaller } from '@vercel/board'
import { RegisterBody } from '../upstream/api/routes.ts'
import { sha256 } from '../upstream/client/ids.ts'
import { createHttp } from '../upstream/server/backend-http.ts'
import { json } from '../upstream/server/errors.ts'
import { wakeable } from '../upstream/server/registrant.ts'
import { waitUntil as vercelWaitUntil } from '../upstream/server/wait-until.ts'
import { compileWatcher } from '../upstream/server/watch-spec.ts'
import { canonicalWatchers, type WatcherSpec } from '../upstream/server/watchers-hash.ts'

/** Registering again this soon after the same registration only repeats it. */
const REGISTER_EVERY_MS = 10_000
/** How long one wake-up runs matches before it leaves the rest to the next. */
const DRAIN_MS = 4 * 60_000
/** How long a wake-up waits for what it pulled to run before it answers 202 and keeps going. */
const WAKE_ANSWER_MS = 2000
/** A pull with nothing to hand out holds this long, when the app pulls on its own. */
const POLL_WAIT_S = 25

export type BordeauxOptions = {
  /** The board's URL: `https://board.example.com`, or `https://board.example.com/b/<name>` for a named board. */
  url: string
  /** The app's credential on the board. It's sent as a bearer token, and only to the board's origin. */
  token?: string
  /** How requests reach the board: `globalThis.fetch` by default, or a service binding's `fetch`. */
  fetch?: typeof fetch
  /**
   * Where this app serves board(), which the board wakes at `<publicUrl>/wake`: an https URL. By
   * default `board({ url })`. Without one, the app registers with no URL and pulls on its own.
   */
  publicUrl?: string
  /**
   * Keeps a wake-up's work going after it's answered. In a Worker, pass `waitUntil` from
   * `cloudflare:workers`: without it, a drain that outlasts the 2-second answer stops with the request.
   * By default, Vercel's request context where there is one, as upstream does.
   */
  waitUntil?: (task: Promise<unknown>) => void
}

const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

/** The app's own code, as http() calls the board for it: the token's holder, with no profile. */
const APP: SelfCaller = { self: null, origin: { via: { kind: 'engine' } } }

export function bordeaux(options: BordeauxOptions) {
  const base: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const { token } = options
  // createHttp checks the URL first, so a bad one fails with its message rather than URL's.
  let origin: string | null = null
  /** The board's fetch with the app's token: upstream's http() expects `fetch` to bring the credentials. */
  const withToken: typeof fetch =
    token === undefined
      ? base
      : (input, init) => {
          const url = input instanceof Request ? input.url : String(input)
          // A signed upload URL is another host's, and the token stays with the board.
          if (new URL(url).origin !== origin) return base(input, init)
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
          if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`)
          return base(input, { ...init, headers })
        }
  const http = createHttp(options.url, { fetch: withToken }, null)
  origin = new URL(options.url).origin
  const later = options.waitUntil ?? vercelWaitUntil
  // http()'s bind only compiles the tails it would run in this process, which registering replaces,
  // so it's never bound: its methods need nothing from the board.
  const { routes: _routes, keeps: _keeps, bind: _bind, close: _close, settlesMentions, sandbox, ...protocol } = http

  let binding: BoardBinding | null = null
  const bound = () => {
    if (!binding) throw new Error("bordeaux: this backend isn't serving a board yet: pass it to board({ backend })")
    return binding
  }
  /** This app's config watchers, as the board holds them. */
  const tails: Record<string, WatcherSpec> = {}
  const hasWork = () => Object.keys(tails).length > 0 || bound().sync.length > 0
  /** What every wake-up carries, so the app can tell the board holds an older registration: the board's own hash of it. */
  const hash = async () => (await sha256(canonicalWatchers(tails, bound().sync))).slice(0, 32)
  /** Where the board wakes this app: an https URL, or null to pull. */
  const here = () => wakeable(options.publicUrl?.replace(/\/+$/, '') ?? bound().url())

  let last: { url: string | null; at: number; result: RegistrationView } | null = null
  let registering: Promise<RegistrationView> | null = null
  /** Registers this app's watchers with the board, as itself, woken at `url`, replacing its last registration. */
  async function register(url: string | null): Promise<RegistrationView> {
    const current = await hash()
    if (last && last.url === url && last.result.hash === current && Date.now() - last.at < REGISTER_EVERY_MS) return last.result
    const sync = bound().sync.map(({ key, platform }) => ({ key, platform }))
    registering ??= protocol
      .register(APP, { watch: tails, ...(sync.length > 0 ? { sync } : {}), url }, new AbortController().signal)
      .then((result) => {
        last = { url, at: Date.now(), result }
        return result
      })
      .finally(() => {
        registering = null
      })
    return registering
  }

  /**
   * Whether a match is one of the watcher's own writes, which never wake it but for what a schedule
   * of its own posted (upstream watch.ts): the app checks too, so a board that matched it anyway
   * doesn't run a watcher on its own reply.
   */
  const ownWrite = ({ watcher, event }: MatchView) =>
    last !== null && event.actor?.id === `${last.result.owner}+${watcher.toLowerCase()}` && !(event.type === 'message.posted' && event.message?.schedule)

  /** Runs one match and acks it: done, its error, or a skip for a watcher this app no longer has. */
  async function runOne(match: MatchView) {
    let outcome: { error?: string; skip?: boolean } = {}
    if (!bound().subscriptions[match.watcher] || ownWrite(match)) outcome = { skip: true }
    else
      try {
        await bound().run(match.watcher, match.event, { trigger: `watch:${match.watcher}:${match.id}`, attempt: match.attempt + 1 })
      } catch (error) {
        console.error(`[board] watcher ${match.watcher} failed:`, error)
        outcome = { error: describe(error) }
      }
    // A lease that ran out was pulled again: that pull's ack is the one that counts.
    await protocol
      .ack(APP, { id: match.id, lease: match.lease, ...outcome }, new AbortController().signal)
      .catch((error: unknown) => console.error(`[board] couldn't ack a match:`, describe(error)))
  }

  const pull = async (query: { limit: number; wait?: number }, signal = new AbortController().signal) => (await protocol.matches(APP, query, signal)).matches

  /** Pulls and runs what matched until nothing's left or this run's time is up, then what sync queued in its inbox. */
  async function drain(): Promise<number> {
    let ran = 0
    const until = Date.now() + DRAIN_MS
    while (Date.now() < until) {
      const matches = await pull({ limit: 10 })
      if (matches.length === 0) break
      // Each is a different watcher's or thread's oldest, so they run side by side.
      await Promise.all(matches.map(runOne))
      ran += matches.length
    }
    return ran + (await bound().pull())
  }

  let polling: AbortController | null = null
  /**
   * For an app the board can't wake: pulls on its own, each pull held open until something matches.
   * Best-effort in a Worker, whose isolate keeps it going only while a request does.
   */
  function poll() {
    if (polling) return
    const controller = (polling = new AbortController())
    void (async () => {
      for (let pause = 1000; !controller.signal.aborted; ) {
        try {
          await register(null)
          const matches = await pull({ limit: 10, wait: POLL_WAIT_S }, controller.signal)
          await Promise.all(matches.map(runOne))
          await bound().pull()
          pause = 1000
        } catch (error) {
          if (controller.signal.aborted) break
          console.error(`[board] couldn't pull matches from ${origin}:`, describe(error))
          await new Promise((resolve) => setTimeout(resolve, pause))
          pause = Math.min(pause * 2, 60_000)
        }
      }
    })()
  }

  let started: Promise<void> | null = null
  let failedAt = 0
  /**
   * On first use, an app with watchers or sync registers them: woken at its URL, or with none, pulling.
   * One that fails tries again on a later use, at most every `REGISTER_EVERY_MS`: nothing would wake
   * an app the board doesn't know.
   */
  function start(): Promise<void> {
    if (started) return started
    if (!hasWork() || Date.now() - failedAt < REGISTER_EVERY_MS) return Promise.resolve()
    const url = here()
    started = register(url).then(
      () => {},
      (error: unknown) => {
        started = null
        failedAt = Date.now()
        console.error(`[board] couldn't register with ${origin}:`, describe(error))
      },
    )
    if (!url) poll()
    return started
  }

  // Any use of the board is when its watchers can register. board() serves no requests on a backend
  // that keeps nothing, so every call is the app's own code's.
  const methods = Object.fromEntries(
    Object.entries(protocol).map(([name, method]) => [
      name,
      (caller: Caller, ...args: unknown[]) => {
        if (binding) later(start())
        return (method as (...input: unknown[]) => unknown)(caller, ...args)
      },
    ]),
  ) as unknown as ProtocolMethods

  const routes: BackendRoute[] = [
    {
      // Nothing in a wake-up is trusted: it only says to pull, and what's pulled comes with the app's own
      // credential. Past a short wait it answers 202 and keeps draining; until then the board holds its
      // next wake-up, so a burst still wakes the app once.
      method: 'POST',
      path: '/wake',
      async handle(request) {
        started ??= Promise.resolve()
        const stale = request.headers.get('x-board-watchers') !== (await hash())
        const running = (async () => {
          if (stale) await register(here())
          return drain()
        })()
        later(running.catch((error: unknown) => console.error(`[board] couldn't run what woke it:`, describe(error))))
        let timer: ReturnType<typeof setTimeout> | undefined
        const waited = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), WAKE_ANSWER_MS)))
        try {
          const ran = await Promise.race([running, waited])
          return ran === null ? new Response(null, { status: 202 }) : json({ ran })
        } finally {
          clearTimeout(timer)
        }
      },
    },
    {
      // Anyone may ask: it sends the app's own watchers, with its own credential. A handle here
      // registers its own on the board, as the protocol's route does.
      method: 'POST',
      path: '/watchers',
      async handle(request, { caller }) {
        if (caller) return json(await methods.register(caller, RegisterBody.parse(await request.json()), request.signal))
        started ??= Promise.resolve()
        const url = here()
        const registration = await register(url)
        if (!url) poll()
        return json(registration)
      },
    },
  ]

  const backend = {
    ...methods,
    // Its own routes are wake-ups and registering: who may do what is the board's to say.
    routes,
    // The log is the board's.
    keeps: false,
    settlesMentions,
    sandbox,
    bind(next: BoardBinding) {
      if (binding) throw new Error('bordeaux: this backend already serves a board: create one bordeaux() per board()')
      for (const [id, subscription] of Object.entries(next.subscriptions)) {
        // Sync's outbound is the `@sync` subscription: its entries register beside the watchers.
        if (subscription.kind !== 'tail') continue
        // A tail the board would refuse fails here, when board() is created.
        compileWatcher(id, subscription)
        tails[id] = { tail: subscription.tail }
      }
      binding = next
    },
    /** Registers this app's watchers with the board now, as `POST /watchers` does. */
    registerWatchers: () => register(here()),
    /** Stops pulling, for an app that pulls on its own. */
    close() {
      polling?.abort()
      polling = null
    },
  }
  return backend satisfies Backend
}

export type BordeauxBackend = ReturnType<typeof bordeaux>
