export class JevHttpError extends Error { constructor(message: string, readonly status: number) { super(message) } }
/** The key never leaves the server. All browser requests are same-origin. */
export async function jevApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch('/api/jev/' + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    const value = await response.json()
    if (!response.ok) throw new JevHttpError(typeof value.error === 'string' ? value.error : 'JEV request failed.', response.status)
    return value as T
  } catch (error) { if (controller.signal.aborted) throw new JevHttpError('Poise did not acknowledge this request in time. Check the evaluation history before repeating it.', 0); throw error }
  finally { clearTimeout(timer) }
}
