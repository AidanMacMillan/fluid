/**
 * A path as a shell would write it: `~/code/fluid` rather than the whole thing
 * from the root down.
 *
 * The renderer has no idea where home is — it is a fact about the machine, and
 * the main process is the side that knows it — so it arrives as an argument
 * rather than being looked up here.
 */
export function shortenPath(path: string, home: string): string {
  if (home === '') return path
  if (path === home) return '~'
  const prefix = home.endsWith('/') ? home : `${home}/`
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path
}
