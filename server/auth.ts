import { getMeta, setMeta } from './db'

const TOKEN_KEY = 'github_token'

let cached: string | null | undefined = undefined

export function getToken(): string | null {
  if (cached !== undefined) return cached
  cached = getMeta(TOKEN_KEY)
  return cached
}

export function setToken(token: string | null): void {
  cached = token
  if (token) setMeta(TOKEN_KEY, token)
  else setMeta(TOKEN_KEY, '')
}

export function hasToken(): boolean {
  const t = getToken()
  return !!(t && t.length > 0)
}
