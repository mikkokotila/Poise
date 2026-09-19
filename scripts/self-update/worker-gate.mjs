#!/usr/bin/env node
// Worker gate for the self-update controller: the process-group leader every
// git, npm and launchctl invocation the controller makes runs under.
//
// The controller records a worker's pid/pgid/identity durably before that
// worker may touch a checkout or a release directory. A command spawned
// directly could start writing in the window between spawn and the durable
// record, and would survive a controller crash unrecorded. The gate closes
// that window: it is spawned first as a detached group leader, the controller
// commits its record, and only then writes `GO\n` on the control descriptor
// (fd 3). Until GO arrives nothing runs; if fd 3 closes first — the
// controller died or refused to register — the gate exits without spawning.
//
// After GO the real command runs in the gate's process group with fds 0–2
// inherited, so the controller reads the command's output through the pipes
// it created; the gate adds no proxying. It stays alive as the group leader
// until every member of the group is gone: when the command exits — normally
// or not — descendants it left behind are terminated (SIGTERM, SIGKILL after
// 5 s) before the gate itself exits, and losing fd 3 (controller crashed) or
// receiving SIGTERM tears the whole group down the same way. The gate never
// reports "done" while something in its group could still write.
//
// Usage: node worker-gate.mjs --self-update-worker <ident> -- <command> [args…]
// The ident on argv is unique per run and lets a later controller verify that
// a pid it recorded is still this gate (`ps -o command=`) before it kills
// anything.

import { spawn, spawnSync } from 'node:child_process'

const KILL_GRACE_MS = 5_000
const SETTLE_DEADLINE_MS = 20_000
const CONTROL_FD = 3

// Kept in sync with GATE_FLAG in safe-runner.mjs; this script is never
// imported, only spawned.
const GATE_FLAG = '--self-update-worker'

const argv = process.argv.slice(2)
const identFlag = argv.indexOf(GATE_FLAG)
const separator = argv.indexOf('--')
if (identFlag !== 0 || separator !== 2 || separator + 1 >= argv.length || !/^[A-Za-z0-9-]{8,64}$/.test(argv[1])) {
  process.stderr.write(`usage: worker-gate ${GATE_FLAG} <ident> -- <command> [args...]\n`)
  process.exit(64)
}
const command = argv[separator + 1]
const args = argv.slice(separator + 2)

let child = null
let stopping = false
let settling = false
let exitCode = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every process in our group except ourselves. `ps -eo pid=,pgid=` is the
// same on macOS and Linux; an unreadable table counts as "members unknown",
// which is treated as members present.
function groupMembers() {
  // ps runs detached so it is not itself a member of the group it lists.
  const result = spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', timeout: 5_000, detached: true })
  if (result.error || result.status !== 0) return null
  const members = []
  for (const line of result.stdout.split('\n')) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pgid === process.pid && pid !== process.pid && Number.isFinite(pid)) members.push(pid)
  }
  return members
}

function signalPid(pid, signal) {
  try { process.kill(pid, signal) } catch { /* already gone */ }
}

// Ask the direct child to stop; descendants are handled by settle().
function stopChild(signal) {
  if (child && child.exitCode === null && child.signalCode === null) signalPid(child.pid, signal)
}

// Terminate whatever is left in the group and wait for it to be gone.
async function settle() {
  if (settling) return
  settling = true
  const started = Date.now()
  let termed = false
  while (true) {
    const members = groupMembers()
    if (members !== null && members.length === 0) return
    const elapsed = Date.now() - started
    if (members === null) {
      process.stderr.write('[worker-gate] cannot list the process group; waiting\n')
    } else if (!termed) {
      for (const pid of members) signalPid(pid, 'SIGTERM')
      termed = true
    } else if (elapsed >= KILL_GRACE_MS) {
      for (const pid of members) signalPid(pid, 'SIGKILL')
    }
    if (elapsed >= SETTLE_DEADLINE_MS) {
      process.stderr.write(`[worker-gate] ${members ? members.length : '?'} process(es) in the worker group did not exit\n`)
      exitCode = 70
      return
    }
    await sleep(50)
  }
}

function finish() {
  void settle().then(() => process.exit(exitCode))
}

function terminate() {
  if (stopping) return
  stopping = true
  if (!child) {
    // Nothing was ever started: leave without touching anything.
    process.exit(3)
    return
  }
  stopChild('SIGTERM')
  setTimeout(() => stopChild('SIGKILL'), KILL_GRACE_MS).unref()
}

function start() {
  child = spawn(command, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
    // Same group as the gate on purpose: the recorded pgid must cover every
    // descendant.
    detached: false,
  })
  child.once('error', (error) => {
    process.stderr.write(`[worker-gate] ${command}: ${error.message}\n`)
    exitCode = 127
    finish()
  })
  child.once('exit', (code, signal) => {
    exitCode = signal
      ? 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGTERM' ? 15 : 1)
      : (code ?? 1)
    finish()
  })
}

let control
try {
  control = new (await import('node:net')).Socket({ fd: CONTROL_FD, readable: true, writable: false })
} catch (error) {
  process.stderr.write(`[worker-gate] control descriptor unavailable: ${error.message}\n`)
  process.exit(65)
}

let pending = ''
let started = false
control.on('data', (chunk) => {
  pending += chunk.toString('utf8')
  let newline
  while ((newline = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, newline).trim()
    pending = pending.slice(newline + 1)
    if (line === 'GO' && !started && !stopping) {
      started = true
      start()
    } else if (line === 'TERM') {
      terminate()
    } else if (line === 'KILL') {
      stopping = true
      if (!child) process.exit(3)
      stopChild('SIGKILL')
    }
  }
})
control.on('close', terminate)
control.on('error', terminate)

// A SIGTERM aimed at the gate means "take the child with you". The gate
// never survives its child and never leaves its descendants behind.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, terminate)
}
