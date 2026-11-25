// Mints a spike JWT: node tools/mint.mjs <sub> <ttl-seconds> [aud]
import { SignJWT } from 'jose'
const [sub = '583231', ttl = '3600', aud = 'http://127.0.0.1:8787'] = process.argv.slice(2)
const jti = crypto.randomUUID().slice(0, 8)
const token = await new SignJWT({ login: 'octocat', jti }).setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub).setAudience(aud).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + Number(ttl))
  .sign(new TextEncoder().encode('spike-only-not-a-secret'))
console.log(token)
