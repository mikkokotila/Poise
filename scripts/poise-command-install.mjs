import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

function shell(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

async function atomicWrite(path, content, mode) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, { mode })
  await rename(temporary, path)
  await chmod(path, mode)
}

export async function installPoiseCommand({
  home,
  node,
  port = '5555',
  projectRoot,
  sourceRoot = projectRoot,
}) {
  for (const [name, value] of Object.entries({ home, node, projectRoot, sourceRoot })) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  }
  const runtimeRoot = join(home, '.local', 'share', 'poise')
  const commandRoot = join(home, '.local', 'bin')
  const runtime = join(runtimeRoot, 'poise-command.mjs')
  const command = join(commandRoot, 'poise')
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('port must be an integer between 1 and 65535')
  }
  const source = await readFile(join(sourceRoot, 'scripts', 'poise-command.mjs'), 'utf8')
  const wrapper = [
    '#!/bin/zsh',
    'set -euo pipefail',
    `export POISE_PRODUCTION_ROOT=${shell(projectRoot)}`,
    `export POISE_PORT=${shell(port)}`,
    `exec ${shell(node)} ${shell(runtime)} "$@"`,
    '',
  ].join('\n')

  await Promise.all([
    mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
    mkdir(commandRoot, { recursive: true, mode: 0o700 }),
  ])
  await atomicWrite(runtime, source, 0o755)
  await atomicWrite(command, wrapper, 0o755)
  return { command, runtime }
}
