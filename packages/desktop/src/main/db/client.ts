import { join } from 'node:path'
import { app } from 'electron'
import { PGlite } from '@electric-sql/pglite'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from './schema'

export type Database = PgliteDatabase<typeof schema>

/**
 * The handle `db().transaction(...)` hands its callback. Derived rather than
 * written out: drizzle's transaction type carries four generic parameters that
 * have to agree with the driver and the schema, and reading it back off the
 * method is the only spelling that cannot drift from them.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

let client: PGlite | undefined
let database: Database | undefined

// This file is bundled to out/main/index.js, and electron-builder packages
// out/ and resources/ as siblings, so one relative hop up serves dev and
// packaged builds alike.
const MIGRATIONS_FOLDER = join(__dirname, '../../resources/migrations')

/** Opens the local database and brings it up to the current schema. */
export async function initDatabase(): Promise<Database> {
  if (database) return database

  client = await PGlite.create({ dataDir: join(app.getPath('userData'), 'pglite') })
  database = drizzle(client, { schema })
  await migrate(database, { migrationsFolder: MIGRATIONS_FOLDER })

  return database
}

/** The live database. Throws if called before `initDatabase()` has resolved. */
export function db(): Database {
  if (!database) {
    throw new Error('Database accessed before initDatabase() completed')
  }
  return database
}

export async function closeDatabase(): Promise<void> {
  await client?.close()
  client = undefined
  database = undefined
}
