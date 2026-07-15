import { describe, expect, it, vi } from 'vitest'
import { createSerializedSaveQueue } from '../src/views/editor-view'

function deferred(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('serialized editor save queue', () => {
  it('persists an update that arrives while a save is in flight', async () => {
    const first = deferred()
    const persisted: string[] = []
    const persist = vi.fn(async (value: string) => {
      persisted.push(value)
      if (value === 'first') await first.promise
    })
    const queue = createSerializedSaveQueue(persist)

    queue.enqueue('first')
    const flush = queue.flush()
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))

    queue.enqueue('second')
    expect(queue.isDirty()).toBe(true)
    expect(queue.pending()).toBe('second')
    first.resolve()

    await expect(flush).resolves.toBe(true)
    expect(persisted).toEqual(['first', 'second'])
    expect(queue.isDirty()).toBe(false)
    expect(queue.pending()).toBeNull()
  })

  it('coalesces unsent snapshots and shares one active drain', async () => {
    const gate = deferred()
    const persisted: string[] = []
    const queue = createSerializedSaveQueue(async (value: string) => {
      persisted.push(value)
      await gate.promise
    })

    queue.enqueue('obsolete')
    queue.enqueue('latest')
    const firstFlush = queue.flush()
    const secondFlush = queue.flush()

    expect(secondFlush).toBe(firstFlush)
    await vi.waitFor(() => expect(persisted).toEqual(['latest']))
    gate.resolve()
    await expect(firstFlush).resolves.toBe(true)
  })

  it('retains dirty state after failure and retries the latest snapshot', async () => {
    let offline = true
    const errors: unknown[] = []
    const persisted: string[] = []
    const queue = createSerializedSaveQueue(
      async (value: string) => {
        if (offline) throw new Error('offline')
        persisted.push(value)
      },
      (error) => { errors.push(error) },
    )

    queue.enqueue('draft')
    await expect(queue.flush()).resolves.toBe(false)
    expect(queue.isDirty()).toBe(true)
    expect(queue.pending()).toBe('draft')
    expect(errors).toHaveLength(1)

    queue.enqueue('revised')
    offline = false
    await expect(queue.flush()).resolves.toBe(true)
    expect(persisted).toEqual(['revised'])
    expect(queue.isDirty()).toBe(false)
  })

  it('discards queued work but waits for an active save to settle', async () => {
    const first = deferred()
    const persisted: string[] = []
    const queue = createSerializedSaveQueue(async (value: string) => {
      persisted.push(value)
      if (value === 'in-flight') await first.promise
    })

    queue.enqueue('in-flight')
    void queue.flush()
    await vi.waitFor(() => expect(persisted).toEqual(['in-flight']))
    queue.enqueue('discarded')
    const discard = queue.discard()

    expect(queue.isDirty()).toBe(false)
    first.resolve()
    await discard
    expect(persisted).toEqual(['in-flight'])
    expect(queue.pending()).toBeNull()
  })
})
