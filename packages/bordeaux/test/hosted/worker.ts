// The hosted tests' Worker: bordeaux with no code of a deployment's own, as Dosu's is, and each
// team's GitHub and Linear sync built from its rows.
import { configure } from '../../src/worker/index.ts'
import { githubTeamSync, linearTeamSync } from '../../src/sync/index.ts'

configure((env) => ({ teamSync: { github: githubTeamSync(env), linear: linearTeamSync(env) } }))

export { default, BoardDO, DirectoryDO, RegistryDO, TailDO } from '../../src/worker/index.ts'
