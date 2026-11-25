import type { BordeauxEnv } from '../src/worker/env.ts'

declare global {
  namespace Cloudflare {
    interface Env extends BordeauxEnv {}
  }
}
