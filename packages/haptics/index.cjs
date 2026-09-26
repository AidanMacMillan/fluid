/* eslint-disable @typescript-eslint/no-require-imports -- Node-API binaries use the CommonJS loader. */
module.exports =
  process.platform === 'darwin' ? require('./build/Release/haptics.node') : { alignment: () => {} }
