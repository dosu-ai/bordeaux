#!/usr/bin/env node
// Holds `count` SSE tails on a board until it's stopped (`scripts/load.mjs` runs it): a process of
// their own, so reading their events doesn't hold up the timing of the posts.
//
//   BOARD_TOKEN=… node scripts/tails.mjs <board url> <count>
const [url, count] = process.argv.slice(2)
let ready = 0
for (let i = 0; i < Number(count); i++) {
  const open = () =>
    fetch(`${url}/events`, { headers: { authorization: `Bearer ${process.env.BOARD_TOKEN}`, accept: 'text/event-stream' } })
      .then(async (response) => {
        if (++ready === Number(count)) process.stdout.write('ready\n')
        for await (const _chunk of response.body) {
        }
      })
      // A stream the server ends, or drops, opens again, as a client's would.
      .catch(() => {})
      .finally(() => setTimeout(open, 100))
  open()
}
