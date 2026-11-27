import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const BDX = join(import.meta.dirname, '../../src/cli/bdx.ts')
const CONFIG = mkdtempSync(join(tmpdir(), 'bdx-'))
afterAll(() => rmSync(CONFIG, { recursive: true, force: true }))

/** Runs bdx with no sign-in and no board, as a person who just installed it, or with the sign-in in `config`. */
function bdx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return bdxIn(CONFIG, ...args)
}

function bdxIn(config: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, XDG_CONFIG_HOME: config }
  delete env.BOARD_URL
  delete env.BOARD_TOKEN
  delete env.BOARD_NAME
  return new Promise((resolve) => {
    execFile(process.execPath, [BDX, ...args], { env, timeout: 15_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    )
  })
}

describe('bdx --help on bordeaux’s own commands', () => {
  it('shows login’s usage instead of signing in to a board called --help', async () => {
    for (const flag of ['--help', '-h']) {
      const run = await bdx('login', flag)
      expect(run).toMatchObject({ code: 0, stderr: '' })
      expect(run.stdout).toBe('usage:\n  bdx login <url>  sign in with GitHub\n')
    }
  })

  it('answers without a sign-in, in 80 columns, for each command bdx --help lists as bordeaux’s', async () => {
    const help = (await bdx('--help')).stdout
    const section = help.slice(help.indexOf('bordeaux:\n'), help.indexOf("board commands (upstream's"))
    // grants is upstream's, with bordeaux's flags added, and sync is upstream's but for add, rm,
    // list, and link: their help is upstream's, and sync's own is below.
    const commands = [...new Set([...section.matchAll(/^ {2}([a-z-]+)/gm)].map(([, command]) => command!))].filter((command) => command !== 'grants' && command !== 'sync')
    expect(commands).toContain('tokens')
    for (const command of commands) {
      const run = await bdx(command, '--help')
      expect(run, command).toMatchObject({ code: 0, stderr: '' })
      expect(run.stdout, command).toMatch(new RegExp(`^usage:\\n  bdx ${command} `))
      for (const line of run.stdout.split('\n')) expect(line.length, `${command}: ${line}`).toBeLessThanOrEqual(80)
    }
    const tokens = await bdx('tokens', '--help')
    expect(tokens.stdout).toContain('bdx tokens create --service <name>')
    expect(tokens.stdout).toContain('bdx tokens list | revoke <id>')
  })

  it('finds the command after a flag’s value', async () => {
    for (const args of [['--name', 'ops', 'gc', '--help'], ['--url', 'https://board.example', 'health', '--help']]) {
      const run = await bdx(...args)
      expect(run, args.join(' ')).toMatchObject({ code: 0, stderr: '' })
      expect(run.stdout, args.join(' ')).toMatch(new RegExp(`^usage:\\n  bdx ${args[2]} `))
    }
  })

  it('leaves upstream’s commands to upstream’s help', async () => {
    const run = await bdx('grants', '--help')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("board commands (upstream's, unchanged):")
  })

  it('answers sync add, rm, list, and link itself, and leaves sync <id> to upstream', async () => {
    for (const action of ['add', 'rm', 'list', 'link']) {
      const run = await bdx('sync', action, '--help')
      expect(run, action).toMatchObject({ code: 0, stderr: '' })
      expect(run.stdout, action).toContain('bdx sync add github <repo> <channel>')
      expect(run.stdout, action).toContain('bdx sync add linear <team> <channel>')
      expect(run.stdout, action).toContain('bdx sync add slack <chan> <channel>')
      for (const line of run.stdout.split('\n')) expect(line.length, `${action}: ${line}`).toBeLessThanOrEqual(80)
    }
    const upstream = await bdx('sync', '--help')
    expect(upstream.code).toBe(0)
    expect(upstream.stdout).not.toContain('bdx sync add github')
    expect(upstream.stdout).toContain('attach it there')
  })
})

describe('bdx login', () => {
  it('says a URL it was given isn’t a board’s, with no stack trace', async () => {
    for (const given of ['not-a-url', 'ftp://board.example']) {
      const run = await bdx('login', given)
      expect(run).toMatchObject({ code: 1, stdout: '' })
      expect(run.stderr).toBe(`bdx: ${given} isn't a board's URL: bdx login https://<board>\n`)
    }
  })

  it('takes the board from --url, as every other command does', async () => {
    const run = await bdx('login', '--url', 'not-a-url')
    expect(run).toMatchObject({ code: 1, stdout: '' })
    expect(run.stderr).toBe("bdx: not-a-url isn't a board's URL: bdx login https://<board>\n")
  })
})

describe('bdx sync add slack', () => {
  it('sends a Slack channel by ID as it is, and by name with the # a shell would take for a comment', async () => {
    const sent: { method: string; path: string; body: string }[] = []
    const board = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => (body += chunk))
      request.on('end', () => {
        sent.push({ method: request.method!, path: request.url!, body })
        response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(request.method === 'POST' ? { created: true, linked: true } : { removed: true }))
      })
    })
    await new Promise<void>((resolve) => board.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(board.address() as AddressInfo).port}`
    // A sign-in, as bdx login keeps it, with an access token that's good for an hour.
    const config = mkdtempSync(join(tmpdir(), 'bdx-signed-'))
    mkdirSync(join(config, 'bordeaux'))
    const tokens = { [url]: { access_token: 'test-access', expires_at: new Date(Date.now() + 3_600_000).toISOString() } }
    writeFileSync(join(config, 'bordeaux', 'credentials.json'), JSON.stringify({ current: url, boards: { [url]: { refresh_token: 'test-refresh', tokens } } }))
    try {
      const named = await bdxIn(config, 'sync', 'add', 'slack', 'support', 'help')
      expect(named).toMatchObject({ code: 0, stderr: 'syncing #support into help\n' })
      const byId = await bdxIn(config, 'sync', 'add', 'slack', 'C0ABCDEFGH', 'help', '--mirror')
      expect(byId).toMatchObject({ code: 0, stderr: 'syncing C0ABCDEFGH with help\n' })
      expect((await bdxIn(config, 'sync', 'rm', 'slack', 'support')).code).toBe(0)
      expect(sent.map(({ method, path, body }) => ({ method, path, body: body && JSON.parse(body) }))).toEqual([
        { method: 'POST', path: '/admin/sync', body: { provider: 'slack', external: '#support', channel: 'help', direction: 'into' } },
        { method: 'POST', path: '/admin/sync', body: { provider: 'slack', external: 'C0ABCDEFGH', channel: 'help', direction: 'mirror' } },
        { method: 'DELETE', path: '/admin/sync?provider=slack&external=%23support', body: '' },
      ])
    } finally {
      board.close()
      rmSync(config, { recursive: true, force: true })
    }
  })
})

describe('bdx sync list', () => {
  it("says which linked platform stopped syncing, and how to link it again", async () => {
    const board = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        sync: [{ provider: 'linear', external: 'ENG', channel: 'eng', direction: 'mirror' }, { provider: 'github', external: 'acme/web', channel: 'prs', direction: 'into' }],
        providers: [
          { provider: 'github', linked: true, install: 'https://github.com/apps/bordeaux-ai-sync/installations/new' },
          { provider: 'linear', linked: true, refused: 'Linear refused the refresh token: bdx sync link linear' },
        ],
      }))
    })
    await new Promise<void>((resolve) => board.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(board.address() as AddressInfo).port}`
    const config = mkdtempSync(join(tmpdir(), 'bdx-signed-'))
    mkdirSync(join(config, 'bordeaux'))
    const tokens = { [url]: { access_token: 'test-access', expires_at: new Date(Date.now() + 3_600_000).toISOString() } }
    writeFileSync(join(config, 'bordeaux', 'credentials.json'), JSON.stringify({ current: url, boards: { [url]: { refresh_token: 'test-refresh', tokens } } }))
    try {
      const run = await bdxIn(config, 'sync', 'list')
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('linear  ENG')
      expect(run.stderr).toBe('linear stopped syncing: Linear refused the refresh token: bdx sync link linear\n')
      for (const line of run.stderr.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    } finally {
      board.close()
      rmSync(config, { recursive: true, force: true })
    }
  })
})
