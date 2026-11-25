// The Worker the tests run: bordeaux, configured as a deployment's `bordeaux.config.ts` would.
import { configure } from '../src/worker/index.ts'
import { testConfig } from './config.ts'

configure(testConfig)
export { default, BoardDO, DirectoryDO, TailDO } from '../src/worker/index.ts'
