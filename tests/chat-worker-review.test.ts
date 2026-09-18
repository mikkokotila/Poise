import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnWorker, type WorkerHandle } from '../server/chat/worker'

const workers: Array<{ worker: WorkerHandle, root: string }> = []
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const writer = "const fs=require('node:fs');let n=0;const p=process.argv[1];setInterval(()=>fs.writeFileSync(p,String(++n)),20)"
async function waitForFile(path: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8') } catch { await delay(20) }
  }
  throw new Error('fixture writer did not start')
}
afterEach(async () => {
  for (const { worker, root } of workers.splice(0)) {
    // These groups were created by this test, never discovered from stale metadata.
    try { process.kill(-worker.pgid, 'SIGKILL') } catch { /* already gone */ }
    await worker.exited
    worker.child.stdin?.destroy()
    worker.child.stdout?.destroy()
    worker.child.stderr?.destroy()
    ;(worker.child.stdio[3] as import('node:stream').Duplex | null)?.destroy()
    await delay(100)
    await rm(root, { recursive: true, force: true })
  }
})

describe.runIf(process.platform !== 'win32')('Chat worker descendant regression cases', () => {
  it('does not report successful termination while a dead leader leaves a writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-worker-review-'))
    const counter = join(root, 'counter')
    const worker = spawnWorker(process.execPath, ['-e', writer, counter], { cwd: root })
    workers.push({ worker, root })
    worker.go()
    await waitForFile(counter)
    process.kill(worker.pid, 'SIGKILL')
    await worker.exited
    // Explicit orphan refusal is acceptable; silently claiming success is not.
    const reportedStopped = await worker.terminate(50).then(() => true, () => false)
    if (reportedStopped) {
      await delay(80)
      const before = await readFile(counter, 'utf8')
      await delay(160)
      expect(await readFile(counter, 'utf8')).toBe(before)
    }
  })

  it('settles descendants before a normally exiting command is considered finished', async () => {
    const root = await mkdtemp(join(tmpdir(), 'poise-worker-normal-review-'))
    const counter = join(root, 'counter')
    const command = [
      "const fs=require('node:fs');const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(writer)},process.argv[1]],{stdio:'ignore'})`,
      "setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},10)",
    ].join(';')
    const worker = spawnWorker(process.execPath, ['-e', command, counter], { cwd: root })
    workers.push({ worker, root })
    worker.go()
    await waitForFile(counter)
    await worker.exited
    await delay(80)
    const before = await readFile(counter, 'utf8')
    await delay(160)
    expect(await readFile(counter, 'utf8')).toBe(before)
  })
})
