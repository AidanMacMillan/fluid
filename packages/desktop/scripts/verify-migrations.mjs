// Checks that the committed migrations are consistent and match the schema.
//
//   pnpm --filter @fluid/desktop db:verify
//
// `drizzle-kit check` only catches conflicts between migrations. It cannot see
// a schema edit that was never turned into a migration, so this also runs
// `generate` against a scratch copy of the migrations folder: any new file
// there means the schema has drifted from what is committed. The real folder
// is never touched, so this is safe with uncommitted work in the tree.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrations = join(desktop, 'resources/migrations')

function drizzle(args, env = {}) {
  const result = spawnSync('pnpm', ['exec', 'drizzle-kit', ...args], {
    cwd: desktop,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const listing = (directory) => readdirSync(directory, { recursive: true }).sort()

drizzle(['check'])

// Inside the package, because drizzle-kit resolves `out` relative to it.
const scratch = mkdtempSync(join(desktop, '.migrations-verify-'))
try {
  cpSync(migrations, scratch, { recursive: true })
  const before = new Set(listing(scratch))
  drizzle(['generate'], { DRIZZLE_OUT: `./${basename(scratch)}` })
  const added = listing(scratch).filter((file) => !before.has(file))
  if (added.length > 0) {
    console.error(
      `\nThe schema has changes with no migration (${added.join(', ')}).\n` +
        'Run `pnpm --filter @fluid/desktop db:generate` and commit the result.'
    )
    // Not process.exit: that would skip the cleanup below.
    process.exitCode = 1
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
