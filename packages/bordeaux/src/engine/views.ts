// Who's who and which channels there are: upstream's actors and channels reducers
// (src/contract/reducers.ts), folded as each batch lands and kept in tables beside the log, so a
// Durable Object that restarts loads them instead of replaying the log.
import type { BoardEvent } from '../upstream/contract/events.ts'
import { foldActors, type Actor, type ActorsState, type Channel, type ChannelsState } from '../upstream/contract/folds.ts'
import { own, setOwn } from '../upstream/contract/own.ts'

export function createViewTables(storage: DurableObjectStorage) {
  storage.sql.exec('create table if not exists bx_actors (id text primary key, data text not null)')
  storage.sql.exec('create table if not exists bx_channels (path text primary key, data text not null)')
}

const emptyChannel = (path: string): Channel => ({ path, lastIndex: 0, messages: 0, threads: 0 })

/** upstream's `channelsReducer` fold, at the pinned commit. */
function foldChannels(state: ChannelsState, event: BoardEvent): string | null {
  if (event.type === 'channel.created') {
    if (own(state, event.payload.channel)) return null
    setOwn(state, event.payload.channel, emptyChannel(event.payload.channel))
    return event.payload.channel
  }
  if (event.type !== 'message.posted') return null
  const { channel, re } = event.payload
  const entry = own(state, channel) ?? setOwn(state, channel, emptyChannel(channel))
  entry.lastIndex = event.index
  entry.messages += 1
  if (re === null) entry.threads += 1
  return channel
}

export class Views {
  readonly actors: ActorsState = { byId: {}, byHandle: {} }
  readonly channels: ChannelsState = {}

  constructor(private readonly storage: DurableObjectStorage) {
    // Each actor as the fold left it: `host` sticks once seen, which its last actor.seen may not say.
    for (const row of storage.sql.exec<{ id: string; data: string }>('select id, data from bx_actors').toArray()) {
      const actor = JSON.parse(row.data) as Actor
      setOwn(this.actors.byId, row.id, actor)
      const key = actor.handle.toLowerCase()
      ;(own(this.actors.byHandle, key) ?? setOwn(this.actors.byHandle, key, [])).push(row.id)
    }
    for (const row of storage.sql.exec<{ path: string; data: string }>('select path, data from bx_channels').toArray())
      setOwn(this.channels, row.path, JSON.parse(row.data) as Channel)
  }

  /** Folds a batch of the board's events and writes what changed: inside the log's transaction. */
  fold(rows: readonly BoardEvent[]) {
    for (const event of rows) {
      if (event.type === 'actor.seen') {
        foldActors(this.actors, event)
        const actor = own(this.actors.byId, event.payload.actor)
        this.storage.sql.exec('insert into bx_actors (id, data) values (?, ?) on conflict (id) do update set data = excluded.data', event.payload.actor, JSON.stringify(actor))
        continue
      }
      const changed = foldChannels(this.channels, event)
      if (changed !== null)
        this.storage.sql.exec('insert into bx_channels (path, data) values (?, ?) on conflict (path) do update set data = excluded.data', changed, JSON.stringify(own(this.channels, changed)))
    }
  }
}
