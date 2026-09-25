import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { context } from './context'

/**
 * Shell integration: a few lines the shell runs on its way up, so that it
 * reports what it is doing — the command that has just started, and the prompt
 * coming back — the way it already reports where it is. That is what lets a
 * terminal's row say `pnpm dev` while the dev server runs and go back to the
 * folder once it stops, as Ghostty's tabs do.
 *
 * Only zsh for now, which is what macOS gives everyone. Another shell simply
 * runs as it always has, and its row stays named after its folder.
 *
 * What the shell prints is the two marks terminals have settled on for this:
 * OSC 133 (`A` as the prompt is drawn, `C` as a command starts, with the
 * command line kitty-style in `cmdline_url`), and OSC 7 for the directory. See
 * `sessions.ts` for the reading of them.
 */

/**
 * zsh reads `$ZDOTDIR/.zshenv` before anything of the user's but the system's,
 * so pointing ZDOTDIR here is the one way in ahead of their own files. The
 * first thing it does is put ZDOTDIR back, which is what makes zsh find the
 * user's .zprofile and .zshrc where they are; the second is to read the user's
 * own .zshenv, as zsh would have.
 *
 * The hooks go in last, and only in an interactive shell: a script started
 * from here reads this file too, and has no prompt to report.
 */
const ZSHENV = `# Written by Fluid's terminal extension, and rewritten each time it starts.
# ZDOTDIR points here so that this is read first; see integration.ts.

if [[ -n "\${FLUID_ZDOTDIR+x}" ]]; then
  builtin export ZDOTDIR="$FLUID_ZDOTDIR"
  builtin unset FLUID_ZDOTDIR
else
  builtin unset ZDOTDIR
fi

{
  builtin typeset _fluid_file="\${ZDOTDIR-$HOME}/.zshenv"
  [[ ! -r "$_fluid_file" ]] || builtin source -- "$_fluid_file"
} always {
  builtin unset _fluid_file
  if [[ -o interactive ]]; then
    # Byte by byte, so a character outside ASCII arrives as its UTF-8.
    _fluid_urlencode() {
      builtin emulate -L zsh -o extendedglob
      builtin local LC_ALL=C
      REPLY="\${1//(#m)[^A-Za-z0-9._~\\/-]/%\${(l:2::0:)$(( [##16] #MATCH ))}}"
    }
    _fluid_precmd() {
      builtin local REPLY
      _fluid_urlencode "$PWD"
      builtin print -rn -- $'\\e]133;A\\a\\e]7;file://'"\${HOST}\${REPLY}"$'\\a'
    }
    _fluid_preexec() {
      builtin local REPLY
      _fluid_urlencode "$1"
      builtin print -rn -- $'\\e]133;C;cmdline_url='"$REPLY"$'\\a'
    }
    builtin autoload -Uz add-zsh-hook
    add-zsh-hook precmd _fluid_precmd
    add-zsh-hook preexec _fluid_preexec
  fi
}
`

/** Where the zsh files were written, once they have been. */
let zshDir: string | null = null

function zshIntegrationDir(): string {
  if (zshDir) return zshDir
  const dir = join(context().dataDir, 'shell-integration', 'zsh')
  mkdirSync(dir, { recursive: true })
  // Rewritten rather than kept: a new version of the extension brings a new
  // version of the file.
  writeFileSync(join(dir, '.zshenv'), ZSHENV)
  zshDir = dir
  return dir
}

/**
 * What `shell` needs added to its environment to load the integration, or
 * nothing for a shell there is none for. A failure to write the files costs
 * the tab its command names, not its shell.
 */
export function integrationEnv(shell: string, env: Record<string, string>): Record<string, string> {
  if (basename(shell) !== 'zsh') return {}
  try {
    const extra: Record<string, string> = { ZDOTDIR: zshIntegrationDir() }
    // Where the user's own files are, for the integration to put back.
    if (env.ZDOTDIR !== undefined) extra.FLUID_ZDOTDIR = env.ZDOTDIR
    return extra
  } catch (error) {
    context().log.error('Failed to write the zsh integration:', error)
    return {}
  }
}
