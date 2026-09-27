import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
export const root = fileURLToPath(new URL('../../../../', import.meta.url))
const aliases = {
  '@fluid/sdk': 'packages/sdk/src/index.ts',
  '@fluid/agent-core': 'packages/agent-core/src/shared/index.ts',
  '@fluid/agent-core/main': 'packages/agent-core/src/main/index.ts'
}
// Exercise source directly, including its real SDK schemas, without requiring a build.
export function loader(mocks = {}) {
  const cache = new Map()
  function load(file) {
    file = resolve(root, file)
    if (!existsSync(file)) file += '.ts'
    if (file in mocks) return mocks[file]
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    const native = createRequire(file)
    const require = (id) => {
      if (id in mocks) return mocks[id]
      if (aliases[id]) return load(aliases[id])
      if (id.startsWith('.')) return load(resolve(dirname(file), id))
      return native(id)
    }
    require.resolve = native.resolve
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    // Transcript tests exercise the fold; Svelte's compiler/typecheck covers its reactivity.
    new Function('module', 'exports', 'require', '$state', source)(
      module,
      module.exports,
      require,
      (value) => value
    )
    return module.exports
  }
  return load
}
