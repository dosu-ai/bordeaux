// Dosu's hosted Worker (spec 09): bordeaux with no code of a deployment's own, so every team gets
// the same board. A hosted deployment refuses watch and sync from configure(). Dosu's own part
// is its terms and privacy policy, at the hub's /terms and /privacy.
import worker from '@dosu/bordeaux/worker'
import { legal } from './legal.ts'

export { BoardDO, DirectoryDO, RegistryDO, TailDO } from '@dosu/bordeaux/worker'

const fetch: typeof worker.fetch = async (request, env, ctx) => legal(request, env.BORDEAUX_HOSTED_URL) ?? worker.fetch(request, env, ctx)

export default { ...worker, fetch }
