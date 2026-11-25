#!/usr/bin/env node
// `npm create @dosu/bordeaux [dir] -- [--url <url>] [--org <github org>] [--client-id <id>]`:
// a new board's Worker project, from ./template. Asks for whatever the flags leave out.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const positional = args.filter((arg, at) => !arg.startsWith('--') && !args[at - 1]?.startsWith('--'))

async function ask(question, fallback) {
  if (!process.stdin.isTTY) return fallback
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = (await rl.question(`${question}${fallback ? ` (${fallback})` : ''}: `)).trim()
  rl.close()
  return answer || fallback
}

const dir = resolve(positional[0] ?? (await ask('Where should the board go', 'my-board')))
const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'board'
const url = (flag('--url') ?? (await ask("The board's public URL", `https://${name}.example.workers.dev`))).replace(/\/+$/, '')
const org = flag('--org') ?? (await ask('The GitHub org whose members use it', ''))
const clientId = flag('--client-id') ?? (await ask("The GitHub App's client ID (docs/github-app.md)", ''))

if (!/^https?:\/\//.test(url)) {
  console.error('the URL is an https URL, like https://board.acme.dev')
  process.exit(2)
}
if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${dir} isn't empty: pick another directory`)
  process.exit(2)
}

const template = join(dirname(fileURLToPath(import.meta.url)), 'template')
cpSync(template, dir, { recursive: true })
// npm drops a published `.gitignore`, so the template ships it without its dot.
renameSync(join(dir, 'gitignore'), join(dir, '.gitignore'))
const fill = (path) => {
  if (statSync(path).isDirectory()) return readdirSync(path).forEach((entry) => fill(join(path, entry)))
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replaceAll('{{name}}', name).replaceAll('{{url}}', url).replaceAll('{{org}}', org).replaceAll('{{clientId}}', clientId))
}
fill(dir)

console.log(`
Made ${name} in ${dir}. Next:

  cd ${positional[0] ?? basename(dir)}
  npm install
  npx wrangler r2 bucket create ${name}-files
  npx wrangler secret put GITHUB_APP_ID          # and GITHUB_PRIVATE_KEY, GITHUB_INSTALLATION_ID
  npm run deploy
  npx bx login ${url}
${org ? '' : '\nSet BORDEAUX_GITHUB_ORG in wrangler.jsonc: no one can sign in without it.\n'}${clientId ? '' : 'Set GITHUB_CLIENT_ID in wrangler.jsonc once you have the GitHub App (docs/github-app.md).\n'}`)
