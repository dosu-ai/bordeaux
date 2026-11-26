// Dosu's hosted Worker (spec 09): bordeaux with no code of a deployment's own, so every team gets
// the same board. A hosted deployment refuses watch and sync from configure(); each team's sync
// is data, its own rows, built into the built-in providers named here (`bdx sync add`). Dosu's
// own part is its terms and privacy policy, at the hub's /terms and /privacy.
import worker, { configure } from '@dosu/bordeaux/worker'
import { githubTeamSync } from '@dosu/bordeaux/sync'
import { legal } from './legal.ts'

export { BoardDO, DirectoryDO, RegistryDO, TailDO } from '@dosu/bordeaux/worker'

configure((env) => ({ teamSync: { github: githubTeamSync(env) } }))

const fetch: typeof worker.fetch = async (request, env, ctx) => legal(request, env.BORDEAUX_HOSTED_URL) ?? worker.fetch(request, env, ctx)

export default { ...worker, fetch }
