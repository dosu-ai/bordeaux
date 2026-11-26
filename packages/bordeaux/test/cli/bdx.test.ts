import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BDX = join(import.meta.dirname, '../../src/cli/bdx.ts')

/** Runs bdx with no sign-in and no board, as a person who just installed it. */
function bdx(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'bdx-')) }
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

  it('answers without a sign-in for each command bordeaux runs itself', async () => {
    const tokens = await bdx('tokens', '--help')
    expect(tokens.code).toBe(0)
    expect(tokens.stdout).toContain('bdx tokens create --service <name>')
    expect(tokens.stdout).toContain('bdx tokens list | revoke <id>')
    for (const command of ['logout', 'boards', 'export', 'import', 'token', 'health', 'dead-letters', 'gc', 'redact', 'doctor', 'redactions']) {
      const run = await bdx(command, '--help')
      expect(run, command).toMatchObject({ code: 0, stderr: '' })
      expect(run.stdout, command).toMatch(new RegExp(`^usage:\\n  bdx ${command} `))
    }
  })

  it('leaves upstream’s commands to upstream’s help', async () => {
    const run = await bdx('grants', '--help')
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("board commands (upstream's, unchanged):")
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
})
