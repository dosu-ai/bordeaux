// The board's schema registry, in session `schemas` of its log. Ported from upstream's
// src/server/schemas.ts at the pinned commit, on the DO's log: the registry is read and appended to
// in one critical section, so a version two writers register at once lands once.
import { HttpError, type Identity, type Protocol, type SchemaView } from '@vercel/board'
import { z } from 'zod'
import { BUILT_IN_SCHEMAS, canonical, checkDefinition, isBuiltInName, parseSchemaId, SCHEMA_DESCRIPTION_MAX, SCHEMA_NAME, SCHEMA_VERSION_MAX, schemaId, SCHEMAS_MAX, type SchemaDefinition } from '../upstream/contract/data-schemas.ts'
import { badRequest, forbidden, notFound } from '../upstream/server/errors.ts'

export const SCHEMAS_SESSION = 'schemas'

type SchemaRow = { name: string; version: number; description: string | null; schema: SchemaDefinition; by: string; at: number }
export type SchemasState = { byId: Record<string, SchemaRow> }
export const emptySchemas = (): SchemasState => ({ byId: {} })

/** The session's event, checked as it's appended (upstream src/contract/contract.ts). */
export const schemaEvents = {
  'schema.created': z.object({
    name: z.string().regex(SCHEMA_NAME),
    version: z.number().int().min(1).max(SCHEMA_VERSION_MAX),
    description: z.string().min(1).max(SCHEMA_DESCRIPTION_MAX).nullable(),
    schema: z.record(z.string(), z.unknown()),
    by: z.string().min(1).max(500),
  }),
}

/** Upstream's fold: a version is its first event, and nothing changes it after. */
export function foldSchemas(state: SchemasState, event: { createdAt: Date; payload: Omit<SchemaRow, 'at'> }): SchemasState {
  const { name, version, description, schema, by } = event.payload
  state.byId[schemaId(name, version)] ??= { name, version, description, schema, by, at: new Date(event.createdAt).getTime() }
  return state
}

const builtIns: SchemaView[] = BUILT_IN_SCHEMAS.map((schema) => ({ id: schemaId(schema.name, schema.version), ...schema, builtIn: true, by: null, at: null }))

const view = (row: SchemaRow): SchemaView => ({
  id: schemaId(row.name, row.version),
  name: row.name,
  version: row.version,
  description: row.description,
  schema: row.schema,
  builtIn: false,
  by: row.by,
  at: new Date(row.at).toISOString(),
})

export function listSchemas(state: SchemasState): Protocol['schemas']['output'] {
  const own = Object.values(state.byId).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version))
  return { schemas: [...builtIns, ...own.map(view)] }
}

export function findSchema(state: SchemasState, { id }: Protocol['schema']['input']): Protocol['schema']['output'] {
  if (!parseSchemaId(id)) throw badRequest(`${id} doesn't name a schema: one is name@version, like sandbox@1`, 'invalid_schema_id')
  const builtIn = builtIns.find((schema) => schema.id === id)
  if (builtIn) return { schema: builtIn }
  const row = state.byId[id]
  if (!row) throw notFound(`schema not found: ${id}`, 'schema_not_found')
  return { schema: view(row) }
}

/**
 * What registering `body` does to `state`: the existing version, or the event that makes it, or why
 * it can't. Registering takes `manage` at `*`, since a schema is the whole board's.
 */
export function registering(state: SchemasState, { principal, actor }: Identity, body: Protocol['createSchema']['input']): { existing: SchemaView } | { event: { type: 'schema.created'; payload: Omit<SchemaRow, 'at'> }; id: string } {
  if (!principal.access.at('manage', '*')) throw forbidden("this token can't register schemas: it needs manage at *")
  if (!SCHEMA_NAME.test(body.name)) throw badRequest('name: a schema name is up to 80 lowercase letters, numbers, and ._-, starting with a letter')
  if (body.version > SCHEMA_VERSION_MAX) throw badRequest(`version: a schema version is at most ${SCHEMA_VERSION_MAX.toLocaleString('en-US')}`)
  if (body.description !== undefined && body.description.length > SCHEMA_DESCRIPTION_MAX) throw badRequest(`description: a schema description is at most ${SCHEMA_DESCRIPTION_MAX.toLocaleString('en-US')} characters`)
  const id = schemaId(body.name, body.version)
  if (isBuiltInName(body.name)) throw new HttpError(409, 'reserved_schema', `${body.name} is a built-in schema: register yours under another name`)
  const problem = checkDefinition(body.schema)
  if (problem !== null) throw badRequest(problem, 'invalid_schema')
  const description = body.description ?? null
  const existing = state.byId[id]
  if (existing) {
    const differs = canonical(existing.schema) !== canonical(body.schema) ? 'definition' : existing.description !== description ? 'description' : null
    if (differs !== null) throw new HttpError(409, 'schema_immutable', `${id} is registered with another ${differs}, and a version never changes: register a new version`)
    return { existing: view(existing) }
  }
  if (Object.keys(state.byId).length >= SCHEMAS_MAX) throw badRequest(`a board registers at most ${SCHEMAS_MAX} schema versions`, 'too_many_schemas')
  return { id, event: { type: 'schema.created', payload: { name: body.name, version: body.version, description, schema: body.schema as SchemaDefinition, by: actor.id } } }
}

export const schemaView = (state: SchemasState, id: string) => view(state.byId[id]!)
