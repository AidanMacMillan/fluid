import { defineConfig } from 'drizzle-kit'

// Generate-only: the SQL lands in resources/migrations and the app applies it
// itself on boot (see src/main/db/client.ts). There is no long-lived database
// URL to point drizzle-kit at, because the data lives inside Electron's
// per-user userData directory.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/main/db/schema.ts',
  out: './resources/migrations',
  strict: true,
  verbose: true
})
