import type { SessionRecord } from '../server/chat/protocol'

/** Slow REST snapshots must not undo a newer streamed model, mode or status. */
export function reconcileSession(current: SessionRecord, incoming: SessionRecord): SessionRecord {
  const record = incoming.lastSeq < current.lastSeq ? current : incoming
  const queue = (current.queue?.revision ?? -1) > (incoming.queue?.revision ?? -1) ? current.queue : incoming.queue
  return queue ? { ...record, queue } : record
}
