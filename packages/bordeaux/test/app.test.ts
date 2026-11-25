import { SELF } from 'cloudflare:test'
import { board, type BoardEventView } from '@vercel/board'
import { describe, expect, it } from 'vitest'
import { bordeaux } from '../src/app/index.ts'
import { api, BASE, tokenFor } from './helpers.ts'

/** Where the app serves board(): the board wakes `<APP>/wake`. */
const APP = 'https://app.test/board'
/** The board, reached as an app reaches it over HTTPS. */
const toBoard: typeof fetch = (input, init) => SELF.fetch(input, init)

describe('an app on a bordeaux board (@dosu/bordeaux/app)', () => {
  it('posts through the board as its token holder, and reads it back', async () => {
    const token = await tokenFor(701, 'appbot')
    const team = board({ backend: bordeaux({ url: BASE, token, fetch: toBoard }) })

    const posted = await team.post('app-posts', 'hello from an app')
    expect(posted).toMatchObject({ channel: 'app-posts', text: 'hello from an app', by: { principal: 'bordeaux:user:701' } })
    expect((await team.thread(posted.id)).message.text).toBe('hello from an app')
    expect((await api(token, 'GET', `/messages/${posted.id}`)).body.message.text).toBe('hello from an app')
  })

  it('registers its watchers by URL, and a wake-up runs what matched and acks it', async () => {
    const token = await tokenFor(702, 'triager')
    const seen: BoardEventView[] = []
    const team = board({
      backend: bordeaux({ url: BASE, token, fetch: toBoard, publicUrl: APP }),
      watch: {
        triage: {
          tail: 'errors-www',
          run: async ({ event, board }) => {
            seen.push(event)
            await board.reply(event.message!.id, 'triaged')
          },
        },
      },
    })

    const registered = await team.fetch(new Request(`${APP}/watchers`, { method: 'POST' }))
    expect(registered.status).toBe(200)
    const registration = (await registered.json()) as { owner: string; url: string; hash: string }
    expect(registration).toMatchObject({ owner: 'bordeaux:user:702', url: APP, watch: { triage: { tail: 'errors-www' } } })

    const oncall = await tokenFor(703, 'oncall')
    const { message } = (await api(oncall, 'POST', '/messages', { channel: 'errors-www', text: 'TypeError in checkout' })).body

    const woke = await team.fetch(new Request(`${APP}/wake`, { method: 'POST', headers: { 'x-board-watchers': registration.hash } }))
    expect(woke.status).toBe(200)
    expect(((await woke.json()) as { ran: number }).ran).toBeGreaterThanOrEqual(1)
    expect(seen.map((event) => [event.type, event.message?.text])).toEqual([['message.posted', 'TypeError in checkout']])

    // The watcher's reply landed, as the app's principal with the watcher's profile; its own reply
    // didn't run it again, and nothing is left to pull.
    const thread = (await api(token, 'GET', `/messages/${message.id}`)).body
    expect(thread.replies.map((reply: { text: string }) => reply.text)).toEqual(['triaged'])
    expect(thread.replies[0].by.principal).toBe('bordeaux:user:702')
    expect((await api(token, 'GET', '/watchers/matches')).body.matches).toEqual([])  })
})
