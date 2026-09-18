// The PATH every launchd service Poise installs runs with.
//
// launchd knows nothing of a shell profile, so what the shell finds is not
// what a service finds. The provider CLIs — Claude Code's native install,
// Grok Build (`grok`), Antigravity (`agy`), Muse (`muse`) — install into
// ~/.local/bin; Codex and an npm-installed Claude Code into Homebrew's bin.
// Caller's release comes first so its agent-interface wins over any stale
// copy on the user's own PATH.
import { join } from 'node:path'

export const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

export function servicePath(home, binRoot) {
  return [...(binRoot ? [binRoot] : []), join(home, '.local', 'bin'), ...SYSTEM_PATH].join(':')
}
