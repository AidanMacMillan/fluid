/**
 * Which files are worth handing to a Claude Code session.
 *
 * An attachment is not sent as bytes in the conversation: it is written to a
 * directory the session may read, and named in the turn. So "supported" means
 * "the Read tool can open it", and that tool takes text of any kind, the four
 * image formats the API accepts, PDFs and notebooks. Everything else it refuses
 * with an error the user never asked for, which is the thing worth catching
 * before the drop rather than after it.
 *
 * Which makes the rule a denylist, not an allowlist, and deliberately so. Text
 * has no finite extension list — `.rs`, `.toml`, `.mdx`, whatever the project
 * is written in next year — so an allowlist would refuse real source files,
 * which is the worse failure of the two. What can be enumerated is the binary
 * formats, and those are what this names.
 */

/** Images the API takes. The rest — bmp, tiff, heic, avif, ico — it does not. */
const IMAGES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** Binary formats, and so the whole of what Claude Code cannot open. */
const BINARY = [
  // Archives, including the office formats that are archives wearing a hat.
  ...['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'dmg', 'iso', 'pkg'],
  ...['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'key', 'pages', 'numbers'],
  // Media. Images that are not one of the four above belong here too: a `.heic`
  // is as unreadable to the model as a `.mov` is.
  ...['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'aiff'],
  ...['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'],
  ...['bmp', 'tiff', 'tif', 'heic', 'heif', 'avif', 'ico', 'psd', 'ai', 'sketch', 'fig'],
  // Things that run, and things that are compiled.
  ...['exe', 'dll', 'so', 'dylib', 'bin', 'app', 'jar', 'class', 'wasm', 'pyc', 'o', 'a'],
  // Fonts and stores.
  ...['ttf', 'otf', 'woff', 'woff2', 'eot', 'sqlite', 'sqlite3', 'db', 'realm']
]

/** The bit after the last dot, lowercased. Empty for a file that has no dot. */
function extension(name: string): string {
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at + 1).toLowerCase()
}

/**
 * Whether Claude Code could read this file if it were handed one.
 *
 * By name rather than by the browser's MIME guess, which is wrong for exactly
 * the files that matter most here: Chromium reports `.ts` as `video/mp2t`, and
 * a rule that trusted it would refuse every TypeScript file dropped into a
 * TypeScript project.
 */
export function supportsFile(name: string): boolean {
  const type = extension(name)
  if (IMAGES[type]) return true
  return !BINARY.includes(type)
}

/**
 * The media type to draw this file as, or null for one that is not an image.
 *
 * Read off the name rather than taken from the browser's own `File.type` for
 * the reason `supportsFile` gives, and against the same list: what the composer
 * previews and what the model can read should not be able to drift apart.
 */
export function imageTypeFor(name: string): string | null {
  return IMAGES[extension(name)] ?? null
}
