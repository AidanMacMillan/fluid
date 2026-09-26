/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS package install script. */
if (process.platform === 'darwin') {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(
    process.execPath,
    [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild'],
    {
      stdio: 'inherit'
    }
  )
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
