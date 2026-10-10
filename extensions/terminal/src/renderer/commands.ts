import type { LauncherQuery } from '@fluid/sdk'

/**
 * Whether what was typed into the launcher is something to run in a shell —
 * the terminal's half of the launcher's ranking (see `Relevance` in the SDK).
 *
 * Built from what people actually start a terminal to do, rather than from
 * what is on this machine's PATH: the launcher scores every keystroke, and has
 * to know `ls` from "list my files" before any round trip could answer.
 */

/** A set of words, from lines of them: the lists below are long, and read best as prose. */
function wordsOf(...lines: string[]): Set<string> {
  return new Set(lines.flatMap((line) => line.split(' ')))
}

/**
 * Commands that are nothing else: nobody opens a sentence with `grep` or
 * `pnpm`, so one of these first is a command whatever follows it.
 */
const COMMANDS = wordsOf(
  // Files and folders
  'ls ll la cd pwd mkdir rmdir rm cp mv ln chmod chown chgrp cat bat eza exa lsd stat du df',
  'dust ncdu zoxide z pushd popd dirs realpath dirname basename mktemp',
  // Text
  'grep egrep fgrep rg ag ack fd fzf sed awk gawk xargs tr wc uniq diff colordiff tee jq yq',
  'fx nl rev tac od xxd hexdump strings base64 shasum sha256sum md5 md5sum cksum iconv',
  'printf echo',
  // Processes and the system
  'ps htop btop glances killall pkill pgrep lsof nohup jobs bg fg disown sudo su doas',
  'whoami id uname hostname uptime cal env printenv alias unalias which whereis whence tldr',
  'crontab systemctl journalctl launchctl dmesg vmstat iostat chsh passwd umask ulimit',
  'caffeinate pmset defaults diskutil hdiutil mdfind mdls osascript sw_vers softwareupdate',
  'pbcopy pbpaste xattr codesign spctl scutil networksetup tmutil',
  // Network
  'curl wget http https xh ssh scp sftp rsync ftp ping traceroute mtr dig nslookup whois',
  'netstat ss ifconfig ip nc ncat telnet nmap arp ngrok cloudflared tailscale openssl',
  'ssh-keygen ssh-add gpg mosh',
  // Archives
  'tar zip unzip gzip gunzip bzip2 xz unxz zstd 7z unrar',
  // Packages and toolchains
  'brew apt apt-get yum dnf pacman zypper apk nix mas git gh glab hg svn lazygit tig jj but',
  'npm npx pnpm pnpx yarn bun bunx deno node nvm fnm volta corepack tsc tsx ts-node vite',
  'vitest jest mocha eslint prettier biome turbo nx lerna webpack esbuild rollup parcel',
  'playwright cypress storybook expo ng nuxt astro svelte-kit python python3 py pip pip3',
  'pipx poetry uv uvx conda mamba pyenv virtualenv pytest ruff mypy ipython jupyter',
  'django-admin flask uvicorn gunicorn ruby gem rake rails irb rbenv rvm cargo rustc rustup',
  'gofmt gopls java javac mvn gradle gradlew kotlin kotlinc sbt scala swift swiftc',
  'xcodebuild xcrun xcode-select pod fastlane simctl dotnet php composer artisan perl lua',
  'luarocks julia elixir iex erl ghc ghci cabal zig nim dart flutter clj lein cmake ninja',
  'meson bazel gcc g++ cc clang clang++ ld lldb gdb valgrind strace dtrace otool nm objdump',
  // Containers and clouds
  'docker docker-compose podman colima orb orbctl kubectl k9s kubectx kubens helm minikube',
  'k3d terraform tofu pulumi ansible vagrant packer aws gcloud gsutil az doctl heroku',
  'vercel netlify flyctl firebase supabase wrangler railway',
  // Databases
  'psql pg_dump pg_restore mysql mysqldump sqlite3 redis-cli mongosh mongo duckdb pgcli',
  'mycli',
  // Editors and multiplexers. Not the coding agents: `claude` typed alone is
  // far more often somebody looking for the Claude Code row than for its CLI.
  'vim nvim vi nano emacs micro hx subl zed tmux zellij ollama',
  // Media
  'ffmpeg ffprobe magick imagemagick yt-dlp youtube-dl pandoc exiftool',
  // Shells
  'zsh bash sh fish nu pwsh exec eval unset'
)

/**
 * Commands that are English words too, and so open sentences as often as
 * command lines: `make build`, or "make a website". Taken for a command only
 * once what follows reads as arguments rather than as more words (see
 * `ARGUMENT`), and otherwise offered under the search rather than over it.
 */
const WORDY_COMMANDS = wordsOf(
  'make open find kill top watch time date sort head tail more less cut file type man',
  'history clear reset exit export source touch patch tree go kind stack screen say read',
  'sleep bundle test set code cursor fly next mix port snap join split paste look yes last',
  'wait shift trap help mount umount nice renice install serve deploy trash delta column',
  'free host route black render'
)

/**
 * A word that is an argument rather than more English: a path or a file name,
 * a number, a flag, a glob, an assignment, `user@host` or `host:port`.
 */
const ARGUMENT = /[./~*=:@\\-]|\d/

/**
 * How sure the terminal is that `query` is a command line, on the launcher's
 * scale: 0.95 for one that opens with a command, 0.9 for one that opens with a
 * path to run, 0.85 for anything with shell syntax in it, 0.75 for a word with
 * flags after it (a tool the list does not know, used the way tools are), 0.4
 * for a command that is also a word, alone or with one more after it, and 0
 * for anything that reads as language, an address, or a word the terminal has
 * never heard of.
 */
export function commandScore(query: LauncherQuery): number {
  if (query.empty || query.multiline || query.url || query.naturalLanguage) return 0
  if (query.path) return 0.9
  if (COMMANDS.has(query.head)) return 0.95
  if (WORDY_COMMANDS.has(query.head)) {
    const args = query.words.slice(1)
    if (query.shellSyntax || args.some((word) => ARGUMENT.test(word))) return 0.9
    // `make test` might be either; "date night ideas" is a phrase.
    return args.length <= 1 ? 0.4 : 0
  }
  if (query.shellSyntax) return 0.85
  if (query.flags && /^[a-z0-9][\w.+-]*$/.test(query.head)) return 0.75
  return 0
}

/** The point past which what was typed is a command, and not a search for the terminal. */
export const COMMAND_THRESHOLD = 0.5
