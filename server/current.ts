import { db } from './db'

export type Lane = 'idea' | 'concept' | 'plan' | 'issue' | 'pr'

export const LANES: Lane[] = ['idea', 'concept', 'plan', 'issue', 'pr']

export interface CurrentCard {
  id: number
  text: string
  lane: Lane
  position: number
  created_at: string
  updated_at: string
}

function isValidLane(s: unknown): s is Lane {
  return typeof s === 'string' && (LANES as string[]).includes(s)
}

const selectAll = db.prepare(`
  SELECT id, text, lane, position, created_at, updated_at
  FROM current_cards
  ORDER BY lane, position
`)

const selectOne = db.prepare(`
  SELECT id, text, lane, position, created_at, updated_at
  FROM current_cards WHERE id = ?
`)

const maxPositionInLane = db.prepare(
  `SELECT COALESCE(MAX(position), -1) AS max FROM current_cards WHERE lane = ?`
)

const insertCard = db.prepare(
  `INSERT INTO current_cards(text, lane, position, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?)`
)

const updateText = db.prepare(
  `UPDATE current_cards SET text = ?, updated_at = ? WHERE id = ?`
)

const deleteCard = db.prepare(`DELETE FROM current_cards WHERE id = ?`)

const cardsInLane = db.prepare(
  `SELECT id FROM current_cards WHERE lane = ? ORDER BY position`
)

const setLaneAndPosition = db.prepare(
  `UPDATE current_cards SET lane = ?, position = ?, updated_at = ? WHERE id = ?`
)

const setPosition = db.prepare(
  `UPDATE current_cards SET position = ?, updated_at = ? WHERE id = ?`
)

export function listCards(): CurrentCard[] {
  return selectAll.all() as CurrentCard[]
}

export function getCard(id: number): CurrentCard | null {
  return (selectOne.get(id) as CurrentCard | undefined) ?? null
}

export function createCard(text: string, lane: Lane): CurrentCard {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Card text is required')
  if (!isValidLane(lane)) throw new Error(`Invalid lane: ${lane}`)
  const now = new Date().toISOString()
  const max = (maxPositionInLane.get(lane) as { max: number }).max
  const result = insertCard.run(trimmed, lane, max + 1, now, now)
  return getCard(Number(result.lastInsertRowid))!
}

export function setCardText(id: number, text: string): CurrentCard {
  const card = getCard(id)
  if (!card) throw new Error('Card not found')
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Card text is required')
  updateText.run(trimmed, new Date().toISOString(), id)
  return getCard(id)!
}

// Move a card to (lane, index). The index is the desired final 0-based position
// among cards in `lane` after the move. Re-numbers positions in the affected
// lane(s) so they stay contiguous integers.
export function moveCard(id: number, lane: Lane, index: number): CurrentCard {
  if (!isValidLane(lane)) throw new Error(`Invalid lane: ${lane}`)
  const card = getCard(id)
  if (!card) throw new Error('Card not found')

  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    const sourceLane = card.lane as Lane
    if (sourceLane === lane) {
      // Same-lane reorder: pull the moving card out, splice it in.
      const ids = (cardsInLane.all(lane) as { id: number }[]).map((r) => r.id).filter((i) => i !== id)
      const clamped = Math.max(0, Math.min(index, ids.length))
      ids.splice(clamped, 0, id)
      ids.forEach((cid, i) => setPosition.run(i, now, cid))
    } else {
      // Cross-lane: remove from source (re-densify it), insert into target at index.
      const sourceIds = (cardsInLane.all(sourceLane) as { id: number }[])
        .map((r) => r.id).filter((i) => i !== id)
      sourceIds.forEach((cid, i) => setPosition.run(i, now, cid))

      const targetIds = (cardsInLane.all(lane) as { id: number }[]).map((r) => r.id)
      const clamped = Math.max(0, Math.min(index, targetIds.length))
      targetIds.splice(clamped, 0, id)
      targetIds.forEach((cid, i) => {
        if (cid === id) setLaneAndPosition.run(lane, i, now, cid)
        else setPosition.run(i, now, cid)
      })
    }
  })
  tx()
  return getCard(id)!
}

export function removeCard(id: number): void {
  const card = getCard(id)
  if (!card) return
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    deleteCard.run(id)
    const ids = (cardsInLane.all(card.lane) as { id: number }[]).map((r) => r.id)
    ids.forEach((cid, i) => setPosition.run(i, now, cid))
  })
  tx()
}
