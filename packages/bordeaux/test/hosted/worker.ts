// The hosted tests' Worker: bordeaux with no code of a deployment's own, as Dosu's is, and each
// team's GitHub, Linear, and Slack sync built from its rows.
import { configure } from '../../src/worker/index.ts'
import { githubTeamSync, linearTeamSync, slackTeamSync } from '../../src/sync/index.ts'

configure((env) => ({ teamSync: { github: githubTeamSync(env), linear: linearTeamSync(env), slack: slackTeamSync(env) } }))

export { default, BoardDO, DirectoryDO, RegistryDO, TailDO } from '../../src/worker/index.ts'
